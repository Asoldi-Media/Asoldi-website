#!/usr/bin/env node
// Delivery backfill, one step (WS8.41): derived delivery stages and email stamps for clients already past those emails.
// Dry run by default; --apply to write. Same options as scripts/backfill-delivery.mjs.
//   node scripts/backfill-delivery-stage.mjs [--apply] [--data-dir <dir>] [--json]
import { runBackfillCli } from './backfill-delivery.mjs';

await runBackfillCli(['delivery-stage']);
