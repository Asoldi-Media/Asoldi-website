#!/usr/bin/env node
// Archives the transcripts of recordings already on client cards (lib/transcript-archive.js).
// A dry run by default: it lists what would be archived (client and meeting ids only) and writes
// nothing. With --apply it writes the missing archive files. Runs against the data dir the hub uses
// (APP_DATA_DIR / DATA_DIR / ~/.asoldi-website-data); it never calls Fireflies or any other service.
//   node scripts/backfill-transcript-archive.mjs [--apply] [--json]
const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const asJson = args.has('--json');

const { syncTranscriptArchive } = await import('../lib/transcript-archive.js');
const result = syncTranscriptArchive({ apply });

if (asJson) {
  console.log(JSON.stringify({ apply, planned: result.planned, written: result.written }, null, 2));
} else {
  console.log(`[transcript-archive] ${apply ? 'apply' : 'dry run'}: ${result.planned.length} recording(s) without an archived copy, ${result.written} written`);
  for (const row of result.planned) console.log(`  ${row.clientId} ${row.meetingId} ${row.sha256.slice(0, 12)}`);
  if (!apply && result.planned.length) console.log('Run again with --apply to write them.');
}
