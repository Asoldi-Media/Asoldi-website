// Ticking Solgt from a signed contract, with the signing switch off and in shadow.
//
// markClientSoldFromSignedContract(clientId, { fastTrack }, signing) keeps the live rule: an e-mailed
// PDF (no fastTrack) never moves a card that has not had Møte and Tilbud, and an e-signature on the
// portal or the preview (fastTrack) ticks Møte, Tilbud and Solgt together. The third argument carries
// only the signer's own options (source, offer, alternative, actor): it never turns fastTrack on, and
// in shadow the signer records the source it was given while the live path runs as before.
//
// node --test scripts/signed-contract-paths.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-signed-contract-paths-'));
process.env.APP_DATA_DIR = DATA_DIR;
process.env.HUB_SAFE_MODE = '1';
delete process.env.DATA_DIR;

const sales = await import('../data/sales.js');
const { saveAutomationSettings } = await import('../data/automation-settings.js');
const { markClientSoldFromSignedContract } = await import('../lib/sales-signed-contract.js');
const { contractSigningSettled } = await import('../lib/contract-signing.js');

test.after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

function seed(id) {
  sales.createSalesClient({ id, businessName: `${id} Example AS`, contactEmail: `${id}@example.com`, contactPerson: 'Kari Example', product: 'asoldi' });
  const card = sales.getSalesClientById(id);
  assert.equal(card.progression.meetingHeld, false);
  assert.equal(card.progression.offerSent, false);
  return card;
}

function shadowRows() {
  const dir = join(DATA_DIR, 'delivery-audit');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((name) => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)))
    .filter((row) => row.kind === 'signing-shadow');
}

function signed(id) {
  return sales.getSalesClientById(id).progression;
}

test('signing off: an e-mailed PDF leaves a card without Møte and Tilbud where it is', async () => {
  seed('paths-mail');
  const result = markClientSoldFromSignedContract('paths-mail');
  await contractSigningSettled('paths-mail');
  assert.equal(result?.progression?.contractSigned, false);
  assert.deepEqual([signed('paths-mail').meetingHeld, signed('paths-mail').offerSent, signed('paths-mail').contractSigned], [false, false, false]);
});

test('signing off: an e-signature ticks Møte, Tilbud and Solgt together', async () => {
  seed('paths-esign');
  const result = markClientSoldFromSignedContract('paths-esign', { fastTrack: true }, { source: 'portal-accept', offerId: '', alternativeIndex: 0, actor: 'client' });
  await contractSigningSettled('paths-esign');
  assert.equal(result?.progression?.contractSigned, true);
  assert.deepEqual([signed('paths-esign').meetingHeld, signed('paths-esign').offerSent, signed('paths-esign').contractSigned], [true, true, true]);
});

test('signing off: the signer options never turn fastTrack on', async () => {
  seed('paths-options');
  markClientSoldFromSignedContract('paths-options', {}, { source: 'portal-accept', fastTrack: true, actor: 'client' });
  await contractSigningSettled('paths-options');
  assert.equal(signed('paths-options').contractSigned, false);
  assert.deepEqual(shadowRows(), [], 'nothing recorded while signing is off');
});

test('signing in shadow: the live rule holds and the signer records the source it was given', async () => {
  saveAutomationSettings({ pilotClientIds: ['paths-shadow-mail', 'paths-shadow-esign'], signing: { enabled: true, mode: 'shadow', paused: null } }, { by: 'test', reason: 'test' });
  seed('paths-shadow-mail');
  seed('paths-shadow-esign');
  markClientSoldFromSignedContract('paths-shadow-mail');
  markClientSoldFromSignedContract('paths-shadow-esign', { fastTrack: true }, { source: 'preview-accept', offerId: '', alternativeIndex: 0, actor: 'client' });
  await contractSigningSettled('paths-shadow-mail');
  await contractSigningSettled('paths-shadow-esign');
  assert.equal(signed('paths-shadow-mail').contractSigned, false, 'the e-mailed PDF still waits for Møte and Tilbud');
  assert.equal(signed('paths-shadow-esign').contractSigned, true, 'the e-signature still signs');
  const rows = shadowRows();
  assert.deepEqual(rows.map((row) => [row.clientId, row.source]).sort(), [['paths-shadow-esign', 'preview-accept'], ['paths-shadow-mail', 'inbox-contract']]);
});
