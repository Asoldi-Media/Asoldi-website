#!/usr/bin/env node
// Restore a delivery snapshot locally (WS8.44). On prod use
// POST /api/admin/system/delivery-snapshots/:id/restore {dryRun} as superadmin instead.
//   node scripts/restore-delivery-snapshot.mjs --snapshot <id> [--dry-run] [--data-dir <dir>]
// A real restore first snapshots the current state as pre-restore-<timestamp>.
function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? '' : String(process.argv[index + 1] || '');
}

const dataDirArg = arg('data-dir');
if (dataDirArg) process.env.APP_DATA_DIR = dataDirArg;
const id = arg('snapshot');
const dryRun = process.argv.includes('--dry-run');
if (!id) {
  console.error('usage: node scripts/restore-delivery-snapshot.mjs --snapshot <id> [--dry-run] [--data-dir <dir>]');
  process.exit(2);
}

const { restoreDeliverySnapshot } = await import('../lib/delivery-snapshots.js');
const { getPersistentDataDir } = await import('../data/storage-path.js');
const result = restoreDeliverySnapshot({ dataDir: getPersistentDataDir(), id, dryRun, by: 'cli' });
if (!result.ok) {
  console.error(`[restore-delivery-snapshot] ${result.error}${result.errors ? `: ${result.errors.join('; ')}` : ''}`);
  process.exit(1);
}
for (const file of result.diff.files) {
  const counts = file.counts || {};
  console.log(`${file.action.padEnd(9)} ${file.name}  snapshot=${file.snapshot.records} now=${file.current?.records ?? '-'}  +${counts.added || 0} -${counts.removed || 0} ~${counts.changed || 0}`);
  for (const change of (file.changed || []).slice(0, 20)) console.log(`          ~ ${change.id}${change.keys ? `: ${change.keys.join(', ')}` : ''}`);
}
for (const file of result.diff.notInSnapshot) console.log(`keep      ${file.name} (not in the snapshot)`);
console.log(dryRun
  ? '[restore-delivery-snapshot] dry run: nothing written.'
  : `[restore-delivery-snapshot] restored ${result.restored.length} files; previous state saved as ${result.preRestoreSnapshotId}. Restart the hub so caches reload.`);
