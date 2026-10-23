#!/usr/bin/env node
// Delivery backfill (WS8.41): site plans, hub planSource and delivery stages for existing clients.
// Dry run by default: prints the counts and writes the report to <dataDir>/migrations/.
//   node scripts/backfill-delivery.mjs [--apply] [--only site-plans|plan-source|delivery-stage] [--data-dir <dir>] [--json]
// --apply takes a delivery snapshot first, applies, and checks that a second run finds nothing left.
// The data dir defaults to APP_DATA_DIR / DATA_DIR / ~/.asoldi-website-data, like the server.
function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? '' : String(process.argv[index + 1] || '');
}

export async function runBackfillCli(defaultSteps = null) {
  const dataDirArg = arg('data-dir');
  if (dataDirArg) process.env.APP_DATA_DIR = dataDirArg;
  const { runDeliveryBackfill, BACKFILL_STEPS } = await import('../lib/delivery-backfill.js');
  const { getPersistentDataDir } = await import('../data/storage-path.js');
  const only = arg('only');
  if (only && !BACKFILL_STEPS.includes(only)) {
    console.error(`[backfill] unknown step ${only}; use one of ${BACKFILL_STEPS.join(', ')}`);
    process.exit(2);
  }
  const steps = only ? [only] : (defaultSteps || [...BACKFILL_STEPS]);
  const apply = process.argv.includes('--apply');
  const dataDir = getPersistentDataDir();
  const report = runDeliveryBackfill({ mode: apply ? 'apply' : 'dry-run', dataDir, by: 'cli', steps });
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }
  const { counts } = report;
  console.log(`[backfill] ${report.mode} on ${dataDir} (steps: ${steps.join(', ')})`);
  console.log(`  clients ${counts.clients} (website ${counts.websiteClients}, SSU ${counts.ssuClients}); signed website ${counts.signedWebsiteClients}, signed SSU ${counts.signedSsuClients}`);
  console.log(`  site plans: write ${counts.sitePlans.write}, existing ${counts.sitePlans.existing}, needs a choice ${counts.sitePlans.needsChoice}, needs confirmation ${counts.sitePlans.needsConfirmation}, no evidence ${counts.sitePlans.noEvidence}, with conflicts ${counts.sitePlans.withConflicts}`);
  console.log(`  plan sources: write ${counts.planSources.write}, existing ${counts.planSources.existing}, linked ${counts.planSources.linkedSites}, unlinked ${counts.planSources.unlinkedSites}, tier warnings ${counts.planSources.tierMismatches}, flag warnings ${counts.planSources.flagMismatches}`);
  console.log(`  stages: write ${counts.stages.write}, unchanged ${counts.stages.unchanged}; email stamps: ${counts.emailStamps.keys} on ${counts.emailStamps.clients} clients`);
  if (report.applied) console.log(`  applied: ${JSON.stringify(report.applied)}; left after apply: ${JSON.stringify(report.remaining)}; snapshot ${report.snapshotId}`);
  if (report.file) console.log(`  report: migrations/${report.file}`);
  return report;
}

const invokedDirectly = /[\\/]backfill-delivery\.mjs$/.test(String(process.argv[1] || ''));
if (invokedDirectly) await runBackfillCli();
