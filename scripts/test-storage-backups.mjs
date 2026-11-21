import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-backups-'));
process.env.APP_DATA_DIR = dataDir;
process.env.DATA_BACKUP_KEEP = '2';

const storage = await import('../data/storage-path.js');

test('writeDataJson keeps live data plus latest and a capped stamp history', () => {
  const filePath = storage.getDataFilePath('sales-clients.json');
  storage.writeDataJson(filePath, [{ id: 1 }]);
  storage.writeDataJson(filePath, [{ id: 2 }]);
  storage.writeDataJson(filePath, [{ id: 3 }]);
  storage.writeDataJson(filePath, [{ id: 4 }]);

  const backups = readdirSync(join(dataDir, 'backups'));
  const latest = backups.filter((name) => name === 'sales-clients.json.latest.json');
  const stamped = backups.filter(
    (name) => name.startsWith('sales-clients.json.') && !name.endsWith('.latest.json')
  );
  assert.equal(latest.length, 1);
  assert.ok(stamped.length <= 2);
  assert.equal(JSON.parse(readFileSync(filePath, 'utf8'))[0].id, 4);
});

test('identical writes do not add another stamped backup', () => {
  const filePath = storage.getDataFilePath('users.json');
  storage.writeDataJson(filePath, [{ username: 'ada' }]);
  const before = readdirSync(join(dataDir, 'backups')).filter((name) =>
    name.startsWith('users.json.')
  ).length;
  storage.writeDataJson(filePath, [{ username: 'ada' }]);
  const after = readdirSync(join(dataDir, 'backups')).filter((name) =>
    name.startsWith('users.json.')
  ).length;
  assert.equal(after, before);
});

test('pruneAllDataBackups deletes extras from an already-full folder', () => {
  const backupDir = join(dataDir, 'backups');
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(join(backupDir, 'sites.json.latest.json'), '[]', 'utf8');
  for (let i = 1; i <= 9; i += 1) {
    const day = String(i).padStart(2, '0');
    writeFileSync(join(backupDir, `sites.json.2026-01-${day}T00-00-00-000Z.json`), `[{"i":${i}}]`, 'utf8');
  }
  const result = storage.pruneAllDataBackups({ keep: 2 });
  assert.equal(result.removed >= 7, true);
  const stamped = readdirSync(backupDir).filter(
    (name) => name.startsWith('sites.json.') && !name.endsWith('.latest.json')
  );
  assert.equal(stamped.length, 2);
  assert.ok(stamped.includes('sites.json.2026-01-08T00-00-00-000Z.json'));
  assert.ok(stamped.includes('sites.json.2026-01-09T00-00-00-000Z.json'));
});

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

test('writes of one file in the same millisecond get separate stamped backups', () => {
  const filePath = storage.getDataFilePath('same-ms-store.json');
  const realNow = Date.now;
  Date.now = () => 1_800_000_000_000;
  try {
    storage.writeDataJson(filePath, [{ n: 1 }], { keep: 5 });
    storage.writeDataJson(filePath, [{ n: 2 }], { keep: 5 });
    storage.writeDataJson(filePath, [{ n: 3 }], { keep: 5 });
  } finally {
    Date.now = realNow;
  }
  const stamped = readdirSync(join(dataDir, 'backups'))
    .filter((name) => name.startsWith('same-ms-store.json.') && !name.endsWith('.latest.json'))
    .sort();
  assert.equal(stamped.length, 3, 'one backup per write');
  assert.deepEqual(
    stamped.map((name) => JSON.parse(readFileSync(join(dataDir, 'backups', name), 'utf8'))[0].n),
    [1, 2, 3],
    'each backup holds its own write, in order',
  );
});
