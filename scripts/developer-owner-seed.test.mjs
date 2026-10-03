import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.APP_DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-dev-owner-seed-'));

const sales = await import('../data/sales.js');
const { ADMIN_DEVELOPER_OWNER_ID } = await import('../lib/developer-assignment.js');

const DATA_DIR = process.env.APP_DATA_DIR;
const CLIENTS_PATH = join(DATA_DIR, 'sales-clients.json');
const SEED_PATH = join(DATA_DIR, 'developer-owner-seed.json');

writeFileSync(CLIENTS_PATH, JSON.stringify([
  { id: 'open-1', businessName: 'Cafe Open', product: 'asoldi', developerOwnerId: '' },
  { id: 'ssu-1', businessName: 'SSU Lead', product: 'ssu', developerOwnerId: '' },
  { id: 'legacy-admin', businessName: 'Legacy Admin', product: 'asoldi', developerOwnerId: 'admin:damian@asoldi.com' },
  { id: 'owned-dev', businessName: 'Dev Owned', product: 'asoldi', developerOwnerId: 'developer:dev-1' },
]));

test('the first seed assigns current website clients to Admin and leaves SSU alone', () => {
  const result = sales.seedExistingDeveloperOwnersToAdmin();
  assert.equal(result.seeded, true);
  assert.equal(result.assignedCount, 1);
  const byId = Object.fromEntries(sales.getSalesClients().map((client) => [client.id, client]));
  assert.equal(byId['open-1'].developerOwnerId, ADMIN_DEVELOPER_OWNER_ID);
  assert.equal(byId['ssu-1'].developerOwnerId, '');
  assert.equal(byId['legacy-admin'].developerOwnerId, ADMIN_DEVELOPER_OWNER_ID);
  assert.equal(byId['owned-dev'].developerOwnerId, 'developer:dev-1');
  assert.equal(existsSync(SEED_PATH), true);
  const meta = JSON.parse(readFileSync(SEED_PATH, 'utf8'));
  assert.ok(meta.existingAssignedToAdminAt);
});

test('clients created after the seed stay unassigned', () => {
  const created = sales.createSalesClient({ businessName: 'Future Cafe', product: 'asoldi' });
  assert.equal(created.developerOwnerId, '');
  const again = sales.seedExistingDeveloperOwnersToAdmin();
  assert.equal(again.seeded, false);
  const fresh = sales.getSalesClientById(created.id);
  assert.equal(fresh.developerOwnerId, '');
});
