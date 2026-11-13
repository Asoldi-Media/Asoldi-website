// A corrected signature tick keeps the earliest time that was recorded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-signing-time-'));
process.env.APP_DATA_DIR = dataDir;
process.env.DATA_DIR = '';

const sales = await import('../data/sales.js');
const { contractSignatureForOffer } = await import('../lib/contract-terms-version.js');

test('turning the signed tick off remembers the earliest signature time', () => {
  const created = sales.createSalesClient({
    businessName: 'Eksempel Bakeri AS',
    contactEmail: 'kari@example.com',
    contactPerson: 'Kari Nordmann',
    product: 'asoldi',
  });
  const on = sales.setSalesProgress(created.id, 'contractSigned', true, { fastTrack: true });
  const t1 = on.contractSignedAt;
  assert.ok(Date.parse(t1));
  assert.equal(on.ext?.contractSigning, undefined);

  const off = sales.setSalesProgress(created.id, 'contractSigned', false);
  assert.equal(off.contractSignedAt, '');
  assert.equal(off.ext.contractSigning.earlierSignedAt, t1);

  const again = sales.setSalesProgress(created.id, 'contractSigned', true, { fastTrack: true });
  assert.ok(Date.parse(again.contractSignedAt) >= Date.parse(t1));
  assert.equal(again.ext.contractSigning.earlierSignedAt, t1);

  const offAgain = sales.setSalesProgress(created.id, 'contractSigned', false);
  assert.equal(offAgain.contractSignedAt, '');
  assert.equal(offAgain.ext.contractSigning.earlierSignedAt, t1);
  const restored = sales.setSalesProgress(created.id, 'contractSigned', true, { fastTrack: true });
  assert.equal(restored.ext.contractSigning.earlierSignedAt, t1);

  const client = sales.getSalesClientById(created.id);
  const sentAt = new Date(Date.parse(t1) - 60_000).toISOString();
  assert.equal(
    contractSignatureForOffer({ status: 'sent', sentAt, salesClientId: client.id }, client).at,
    t1,
  );
});
