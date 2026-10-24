#!/usr/bin/env node
// Delivery backfill, one step (WS8.41): client.sitePlan (source backfill) for signed website clients; SSU clients never get one.
// Dry run by default; --apply to write. Same options as scripts/backfill-delivery.mjs.
//   node scripts/backfill-site-plans.mjs [--apply] [--data-dir <dir>] [--json]
import { runBackfillCli } from './backfill-delivery.mjs';

await runBackfillCli(['site-plans']);
