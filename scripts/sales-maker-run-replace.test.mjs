import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = join(tmpdir(), `asoldi-sales-replace-${Date.now()}`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'sales-clients.json'), '[]\n', 'utf8');
process.env.APP_DATA_DIR = dir;
process.env.DATA_DIR = dir;

const sales = await import('../data/sales.js');

test('replaceSalesMakerRun unlinks a run instead of merging leftover step status', () => {
  const created = sales.createSalesClient({
    businessName: 'Test Client',
    contactPerson: 'Ada',
    contactEmail: 'ada@example.com',
    product: 'asoldi',
  });
  sales.setSalesMakerRun(created.id, {
    runId: '2438f2b4-d493-47c6-aa03-9d60d0ea61ef',
    latestReadyStep: '2',
    intakeStatus: 'configured',
  });
  const cleared = sales.replaceSalesMakerRun(created.id, {});
  assert.equal(cleared.makerRun.runId, '');
  assert.equal(cleared.makerRun.latestReadyStep, '');
  assert.equal(cleared.makerRun.intakeStatus, '');
});

test('replaceSalesWebsiteImport clears a public preview link and leaves the client in place', () => {
  const created = sales.createSalesClient({
    businessName: 'Preview Client',
    contactPerson: 'Ada',
    contactEmail: 'preview@example.com',
    product: 'asoldi',
  });
  sales.setSalesWebsiteImport(created.id, {
    publicUrl: 'https://asoldi.com/sales-preview/old-id/',
    sourceRunId: '2438f2b4-d493-47c6-aa03-9d60d0ea61ef',
    sourceStep: 'custom',
  });
  const cleared = sales.replaceSalesWebsiteImport(created.id, {});
  assert.equal(cleared.websiteImport.publicUrl, '');
  assert.equal(cleared.websiteImport.sourceRunId, '');
  assert.equal(sales.getSalesClientById(created.id).businessName, 'Preview Client');
});

test.after(() => {
  rmSync(dir, { recursive: true, force: true });
});
