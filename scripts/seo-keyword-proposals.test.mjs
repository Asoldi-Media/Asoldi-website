// Keyword proposals in the SEO record (proposeAgreedKeywords in lib/seo-ops/record.js): proposals from
// meetings or the client's own answers are added as 'proposed' rows only, a stored row of any status
// is never changed, a removed proposal is not made again, regulated and over-long phrases are skipped,
// and nothing is written when nothing changes. Every business here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-seo-proposals-'));
process.env.APP_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const record = await import('../lib/seo-ops/record.js');
const clientFile = (id) => join(dataDir, 'seo-ops', 'clients', `${id}.json`);

test('proposals are added as proposed rows with their source and quote reference, never approved', async () => {
  const result = await record.proposeAgreedKeywords('sc-prop-1', [
    { phrase: 'sykkelservice havnvik', quoteRef: 'meeting:m-1' },
    'reparasjon av elsykkel',
  ], { source: 'transcript', by: 'transcript-keywords' });
  assert.deepEqual(result.added, ['sykkelservice havnvik', 'reparasjon av elsykkel']);
  assert.deepEqual(result.skipped, []);
  const stored = record.readSeoRecord('sc-prop-1');
  assert.deepEqual(stored.agreedKeywords.map((row) => [row.phrase, row.status, row.source]), [
    ['sykkelservice havnvik', 'proposed', 'transcript'],
    ['reparasjon av elsykkel', 'proposed', 'transcript'],
  ]);
  assert.equal(stored.agreedKeywords[0].quoteRef, 'meeting:m-1');
  assert.equal(stored.agreedKeywords.some((row) => row.status === 'approved'), false);
  assert.equal(record.agreedKeywordsFor(stored).length, 0, 'no approved keyword, so no contract text and no consumer change');
  assert.equal(record.recordGuidesConsumers(stored), false);
  assert.deepEqual(stored.history.at(-1), { at: stored.history.at(-1).at, by: 'transcript-keywords', action: 'propose', source: 'transcript', phrases: ['sykkelservice havnvik', 'reparasjon av elsykkel'] });
});

test('a stored row of any status is kept as it is, and the same phrase in another case is not added again', async () => {
  await record.updateClientSeo('sc-prop-2', { agreedKeywords: [
    { phrase: 'snekker havnvik', status: 'approved', source: 'sales' },
    { phrase: 'billig snekker', status: 'blocked', source: 'developer' },
  ] }, { by: 'dev' });
  const before = readFileSync(clientFile('sc-prop-2'), 'utf8');
  const result = await record.proposeAgreedKeywords('sc-prop-2', ['Snekker Havnvik', 'billig snekker'], { source: 'client', by: 'client' });
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.skipped.map((row) => row.reason), ['exists', 'exists']);
  assert.equal(readFileSync(clientFile('sc-prop-2'), 'utf8'), before, 'nothing is written when nothing changes');
});

test('a proposal a person removed is not proposed again from the same source', async () => {
  await record.proposeAgreedKeywords('sc-prop-3', ['kjøkken på mål'], { source: 'transcript' });
  await record.updateClientSeo('sc-prop-3', { agreedKeywords: [] }, { by: 'dev' });
  assert.deepEqual(record.readSeoRecord('sc-prop-3').agreedKeywords, []);
  const again = await record.proposeAgreedKeywords('sc-prop-3', ['kjøkken på mål'], { source: 'transcript' });
  assert.deepEqual(again.added, []);
  assert.deepEqual(again.skipped, [{ phrase: 'kjøkken på mål', reason: 'proposed-before' }]);
  const fromClient = await record.proposeAgreedKeywords('sc-prop-3', ['kjøkken på mål'], { source: 'client' });
  assert.deepEqual(fromClient.added, ['kjøkken på mål'], 'the client naming it is a new proposal');
});

test('regulated, empty and over-long phrases are skipped; a new source hash is kept even with nothing added', async () => {
  const result = await record.proposeAgreedKeywords('sc-prop-4', [
    'botox behandling havnvik',
    '   ',
    'en veldig lang frase med alt for mange ord i seg',
    'hudpleie havnvik',
  ], { source: 'transcript', sourceHash: 'h-1' });
  assert.deepEqual(result.added, ['hudpleie havnvik']);
  assert.deepEqual(result.skipped.map((row) => row.reason), ['regulated', 'empty-phrase', 'too-many-words']);
  const first = record.readSeoRecord('sc-prop-4');
  assert.equal(first.keywordProposals.transcript.sourceHash, 'h-1');
  assert.equal(first.agreedKeywords.some((row) => /botox/i.test(row.phrase)), false);

  const same = readFileSync(clientFile('sc-prop-4'), 'utf8');
  await record.proposeAgreedKeywords('sc-prop-4', ['hudpleie havnvik'], { source: 'transcript', sourceHash: 'h-1' });
  assert.equal(readFileSync(clientFile('sc-prop-4'), 'utf8'), same, 'the same inputs again write nothing');
  await record.proposeAgreedKeywords('sc-prop-4', [], { source: 'transcript', sourceHash: 'h-2' });
  assert.equal(record.readSeoRecord('sc-prop-4').keywordProposals.transcript.sourceHash, 'h-2');
});

test('no client file is created when there is nothing to propose and no source hash', async () => {
  const result = await record.proposeAgreedKeywords('sc-prop-5', ['melatonin'], { source: 'transcript' });
  assert.deepEqual(result.added, []);
  assert.equal(existsSync(clientFile('sc-prop-5')), false);
});

test('an unknown source is refused before anything is read or written', async () => {
  await assert.rejects(() => record.proposeAgreedKeywords('sc-prop-6', ['hudpleie'], { source: 'sales' }), (error) => error.code === 'invalid-source');
  assert.equal(existsSync(clientFile('sc-prop-6')), false);
});
