// WS8.44: delivery snapshots, the schema-bump startup hook, and restore (dry run first).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-delivery-snapshot-'));
process.env.APP_DATA_DIR = DATA_DIR;

const snapshots = await import('../lib/delivery-snapshots.js');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function freshDir(name) {
  return mkdtempSync(join(tmpdir(), `asoldi-delivery-snapshot-${name}-`));
}

function writeStores(dir, clients, sites = [{ id: 's1', site_key: 'k1', name: 'Site one' }]) {
  writeFileSync(join(dir, 'sales-clients.json'), JSON.stringify(clients, null, 2));
  writeFileSync(join(dir, 'sites.json'), JSON.stringify(sites, null, 2));
}

const baseClients = [
  { id: 'c1', businessName: 'Alpha AS', notes: 'one' },
  { id: 'c2', businessName: 'Beta AS', notes: 'two' },
];

test('a schema bump creates exactly one snapshot; the same version and older code create none', () => {
  const dir = freshDir('bump');
  writeStores(dir, baseClients);
  const quiet = { log: () => {}, warn: () => {} };

  const first = snapshots.runDeliverySchemaStartupSnapshot({ dataDir: dir, codeVersion: 1, log: quiet });
  assert.equal(first.action, 'snapshot');
  assert.equal(snapshots.listDeliverySnapshots({ dataDir: dir }).length, 1);
  assert.equal(snapshots.readStoredSchemaVersion({ dataDir: dir }).version, 1);

  const again = snapshots.runDeliverySchemaStartupSnapshot({ dataDir: dir, codeVersion: 1, log: quiet });
  assert.equal(again.action, 'none');
  assert.equal(snapshots.listDeliverySnapshots({ dataDir: dir }).length, 1);

  const bumped = snapshots.runDeliverySchemaStartupSnapshot({ dataDir: dir, codeVersion: 2, log: quiet });
  assert.equal(bumped.action, 'snapshot');
  const list = snapshots.listDeliverySnapshots({ dataDir: dir });
  assert.equal(list.length, 2);
  assert.ok(list[0].id.startsWith('batch-2-'), list[0].id);
  assert.equal(list[0].schemaVersion, 1, 'the snapshot records the schema of the data it copied');
  assert.deepEqual(list[0].files.map((file) => file.name), ['sales-clients.json', 'sites.json']);
  assert.equal(list[0].files[0].records, 2);

  // Reverted (older) code on newer data: no snapshot, stored version not lowered.
  let warned = '';
  const older = snapshots.runDeliverySchemaStartupSnapshot({ dataDir: dir, codeVersion: 1, log: { warn: (msg) => { warned = msg; } } });
  assert.equal(older.action, 'newer-data');
  assert.match(warned, /newer than this code/);
  assert.equal(snapshots.readStoredSchemaVersion({ dataDir: dir }).version, 2);
  assert.equal(snapshots.listDeliverySnapshots({ dataDir: dir }).length, 2);
});

test('a fresh data dir stores the version without an empty snapshot', () => {
  const dir = freshDir('fresh');
  const result = snapshots.runDeliverySchemaStartupSnapshot({ dataDir: dir, codeVersion: 1, log: null });
  assert.equal(result.action, 'fresh');
  assert.equal(snapshots.listDeliverySnapshots({ dataDir: dir }).length, 0);
  assert.equal(snapshots.readStoredSchemaVersion({ dataDir: dir }).version, 1);
});

test('only the newest 3 snapshots are kept, and only allowlisted stores are copied', () => {
  const dir = freshDir('keep');
  writeStores(dir, baseClients);
  writeFileSync(join(dir, 'users.json'), '[]');
  let at = Date.parse('2026-11-01T00:00:00.000Z');
  for (let i = 0; i < 5; i += 1) {
    snapshots.createDeliverySnapshot({ dataDir: dir, label: `n${i}`, now: new Date(at += 60_000) });
  }
  const list = snapshots.listDeliverySnapshots({ dataDir: dir });
  assert.deepEqual(list.map((entry) => entry.label), ['n4', 'n3', 'n2']);
  const copied = readdirSync(join(dir, 'snapshots', list[0].id)).sort();
  assert.deepEqual(copied, ['manifest.json', 'sales-clients.json', 'sites.json']);
});

test('restore: the dry run lists the diff and writes nothing; the real restore keeps a pre-restore copy', () => {
  const dir = freshDir('restore');
  writeStores(dir, baseClients);
  let at = Date.parse('2026-11-02T00:00:00.000Z');
  const target = snapshots.createDeliverySnapshot({ dataDir: dir, label: 'before-batch', now: new Date(at += 60_000) });
  snapshots.createDeliverySnapshot({ dataDir: dir, label: 'later-a', now: new Date(at += 60_000) });
  snapshots.createDeliverySnapshot({ dataDir: dir, label: 'later-b', now: new Date(at += 60_000) });

  // A later batch changes c1, removes c2 and adds c3.
  const changed = [
    { id: 'c1', businessName: 'Alpha AS', notes: 'edited', sitePlan: { tierId: 'tier-2-seo' } },
    { id: 'c3', businessName: 'Gamma AS' },
  ];
  writeFileSync(join(dir, 'sales-clients.json'), JSON.stringify(changed, null, 2));
  const before = readFileSync(join(dir, 'sales-clients.json'), 'utf8');

  const dry = snapshots.restoreDeliverySnapshot({ dataDir: dir, id: target.id });
  assert.equal(dry.ok, true);
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.restored, []);
  const clientsDiff = dry.diff.files.find((file) => file.name === 'sales-clients.json');
  assert.equal(clientsDiff.action, 'replace');
  assert.deepEqual(clientsDiff.added, ['c2']);
  assert.deepEqual(clientsDiff.removed, ['c3']);
  assert.deepEqual(clientsDiff.changed, [{ id: 'c1', keys: ['notes', 'sitePlan'] }]);
  assert.equal(dry.diff.files.find((file) => file.name === 'sites.json').action, 'unchanged');
  assert.equal(readFileSync(join(dir, 'sales-clients.json'), 'utf8'), before, 'dry run wrote nothing');

  const real = snapshots.restoreDeliverySnapshot({ dataDir: dir, id: target.id, dryRun: false, now: new Date(at += 60_000) });
  assert.equal(real.ok, true);
  assert.deepEqual(real.restored, ['sales-clients.json']);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'sales-clients.json'), 'utf8')), baseClients);
  const ids = snapshots.listDeliverySnapshots({ dataDir: dir }).map((entry) => entry.id);
  assert.ok(ids.includes(real.preRestoreSnapshotId));
  assert.ok(ids.includes(target.id), 'the restored snapshot is protected from pruning');
  const pre = JSON.parse(readFileSync(join(dir, 'snapshots', real.preRestoreSnapshotId, 'sales-clients.json'), 'utf8'));
  assert.deepEqual(pre, changed, 'pre-restore holds the state that was replaced');
});

test('restore refuses bad ids, tampered copies and files outside the delivery stores', () => {
  const dir = freshDir('refuse');
  writeStores(dir, baseClients);
  const snap = snapshots.createDeliverySnapshot({ dataDir: dir, label: 'x' });
  assert.equal(snapshots.restoreDeliverySnapshot({ dataDir: dir, id: '../secrets' }).status, 400);
  assert.equal(snapshots.restoreDeliverySnapshot({ dataDir: dir, id: 'nope-123' }).status, 404);

  writeFileSync(join(dir, 'snapshots', snap.id, 'sales-clients.json'), '[{"id":"evil"}]');
  const tampered = snapshots.restoreDeliverySnapshot({ dataDir: dir, id: snap.id, dryRun: false });
  assert.equal(tampered.ok, false);
  assert.equal(tampered.status, 409);
  assert.match(tampered.errors.join(' '), /checksum/);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'sales-clients.json'), 'utf8')), baseClients);

  const manifestPath = join(dir, 'snapshots', snap.id, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.files = [{ name: 'users.json' }];
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const outside = snapshots.restoreDeliverySnapshot({ dataDir: dir, id: snap.id, dryRun: false });
  assert.equal(outside.ok, false);
  assert.match(outside.errors.join(' '), /not a delivery store/);
  assert.equal(existsSync(join(dir, 'users.json')), false);
});

test('CLI: snapshot, list and dry-run restore on a given data dir', () => {
  const dir = freshDir('cli');
  writeStores(dir, baseClients);
  const made = execFileSync(process.execPath, ['scripts/delivery-snapshot.mjs', '--data-dir', dir, '--label', 'cli'], { cwd: root, encoding: 'utf8' });
  const id = made.match(/\] (cli-[a-z0-9-]+):/)?.[1];
  assert.ok(id, made);
  assert.match(execFileSync(process.execPath, ['scripts/delivery-snapshot.mjs', '--data-dir', dir, '--list'], { cwd: root, encoding: 'utf8' }), new RegExp(id));
  writeFileSync(join(dir, 'sales-clients.json'), JSON.stringify([{ id: 'c1' }]));
  const dry = execFileSync(process.execPath, ['scripts/restore-delivery-snapshot.mjs', '--data-dir', dir, '--snapshot', id, '--dry-run'], { cwd: root, encoding: 'utf8' });
  assert.match(dry, /replace\s+sales-clients\.json/);
  assert.match(dry, /dry run: nothing written/);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'sales-clients.json'), 'utf8')), [{ id: 'c1' }]);
});
