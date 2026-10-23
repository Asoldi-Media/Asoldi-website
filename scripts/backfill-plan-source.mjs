#!/usr/bin/env node
// Delivery backfill, one step (WS8.41): hub site planSource {kind:'backfill'} for linked sites; live flags and websitePlan stay as they are.
// Dry run by default; --apply to write. Same options as scripts/backfill-delivery.mjs.
//   node scripts/backfill-plan-source.mjs [--apply] [--data-dir <dir>] [--json]
import { runBackfillCli } from './backfill-delivery.mjs';

await runBackfillCli(['plan-source']);
