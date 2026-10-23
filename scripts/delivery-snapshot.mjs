#!/usr/bin/env node
// Snapshot the delivery stores (WS8.44). Run before a batch deploy or a risky data change.
//   node scripts/delivery-snapshot.mjs [--label <name>] [--reason <text>] [--data-dir <dir>]
//   node scripts/delivery-snapshot.mjs --list [--data-dir <dir>]
// The data dir defaults to APP_DATA_DIR / DATA_DIR / ~/.asoldi-website-data, like the server.
function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? '' : String(process.argv[index + 1] || '');
}

const dataDirArg = arg('data-dir');
if (dataDirArg) process.env.APP_DATA_DIR = dataDirArg;

const { createDeliverySnapshot, listDeliverySnapshots, readStoredSchemaVersion, DELIVERY_SCHEMA_VERSION } = await import('../lib/delivery-snapshots.js');
const { getPersistentDataDir } = await import('../data/storage-path.js');
const dataDir = getPersistentDataDir();

if (process.argv.includes('--list')) {
  const schema = readStoredSchemaVersion({ dataDir });
  console.log(`[delivery-snapshot] data dir ${dataDir}; stored schema v${schema.version}, code schema v${DELIVERY_SCHEMA_VERSION}`);
  for (const snapshot of listDeliverySnapshots({ dataDir })) {
    console.log(`${snapshot.id}  ${snapshot.createdAt}  schema v${snapshot.schemaVersion}  ${snapshot.files.map((file) => `${file.name}(${file.records ?? '?'})`).join(' ')}  ${snapshot.reason || ''}`);
  }
  process.exit(0);
}

const snapshot = createDeliverySnapshot({ dataDir, label: arg('label') || 'manual', reason: arg('reason') || 'manual snapshot (CLI)' });
console.log(`[delivery-snapshot] ${snapshot.id}: ${snapshot.files.length} files -> ${snapshot.dir}`);
if (snapshot.pruned.length) console.log(`[delivery-snapshot] pruned ${snapshot.pruned.join(', ')}`);
