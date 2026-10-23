// The sales contact corrections hold client contact data, so they load from the data disk, not the repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-contact-corrections-'));
process.env.APP_DATA_DIR = dataDir;
const { loadSalesContactCorrections, SALES_CONTACT_CORRECTIONS } = await import('../data/sales-contact-corrections.js');

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

test('no file means no corrections', () => {
  assert.deepEqual(SALES_CONTACT_CORRECTIONS, []);
  assert.deepEqual(loadSalesContactCorrections(dataDir), []);
});

test('reads an array or { corrections } from the data dir and skips rows without a business name', () => {
  const row = { businessName: 'Testkafe AS', contactEmail: 'post@example.com', createIfMissing: true };
  writeFileSync(join(dataDir, 'sales-contact-corrections.json'), JSON.stringify([row, { notes: 'no name' }]));
  assert.deepEqual(loadSalesContactCorrections(dataDir), [row]);
  writeFileSync(join(dataDir, 'sales-contact-corrections.json'), JSON.stringify({ corrections: [row] }));
  assert.deepEqual(loadSalesContactCorrections(dataDir), [row]);
  writeFileSync(join(dataDir, 'sales-contact-corrections.json'), '{ not json');
  assert.deepEqual(loadSalesContactCorrections(dataDir), []);
});

test('the module in the repo carries no contact data', () => {
  const source = readFileSync(new URL('../data/sales-contact-corrections.js', import.meta.url), 'utf8');
  assert.equal(/@[a-z0-9-]+\.[a-z]{2,}/i.test(source), false);
  assert.equal(/\+47|\b\d{8}\b/.test(source), false);
});

test('the export script restores the old bundled list as data-dir JSON, outside the repo only', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const { exportCorrections, DEFAULT_REV } = await import('./export-sales-contact-corrections.mjs');
  try {
    execFileSync('git', ['cat-file', '-e', `${DEFAULT_REV}:data/sales-contact-corrections.js`], { stdio: 'ignore' });
  } catch {
    t.skip(`commit ${DEFAULT_REV} is not in this clone`);
    return;
  }
  const outDir = mkdtempSync(join(tmpdir(), 'asoldi-corrections-export-'));
  try {
    const result = await exportCorrections({ out: join(outDir, 'sales-contact-corrections.json') });
    assert.ok(result.count > 0);
    const rows = loadSalesContactCorrections(outDir);
    assert.equal(rows.length, result.count, 'the hub loader reads every exported row');
    await assert.rejects(exportCorrections({ out: join(outDir, 'sales-contact-corrections.json') }), /exists; pass --force/);
    await assert.rejects(
      exportCorrections({ out: fileURLToPath(new URL('../tmp-export-corrections.json', import.meta.url)) }),
      /inside the repo/
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
