#!/usr/bin/env node
/**
 * Rebind Påminnelse to 1h before the meeting, set Pokebutikk / Terjesen times,
 * resync Google Calendar, and send confirmation with the new time.
 *
 *   node scripts/backfill-meeting-times.mjs --dry-run
 *   node scripts/backfill-meeting-times.mjs --prod --dry-run
 *   node scripts/backfill-meeting-times.mjs --prod
 */
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  const text = readFileSync(filePath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env) || process.env[key] === '') process.env[key] = value;
  }
}

async function runProduction({ dryRun }) {
  const baseUrl = String(process.env.PROD_ADMIN_URL || 'https://asoldi.com').replace(/\/$/, '');
  const username = process.env.PROD_ADMIN_USERNAME || process.env.ADMIN_USERNAME || process.env.ASOLDI_ADMIN_USER || 'asoldi.com';
  const password = process.env.PROD_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || process.env.ASOLDI_ADMIN_PASS;
  if (!password) {
    throw new Error('Set PROD_ADMIN_PASSWORD or ADMIN_PASSWORD to backfill asoldi.com.');
  }
  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const loginBody = await login.json().catch(() => ({}));
  if (!login.ok || !loginBody.token) {
    throw new Error(`Admin login failed (${login.status}): ${loginBody.message || 'no token'}`);
  }
  const res = await fetch(`${baseUrl}/api/admin/sales/backfill-meeting-times`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${loginBody.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ dryRun, sendConfirmations: !dryRun }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Backfill failed (${res.status}): ${body.message || 'error'}`);
  }
  console.log(JSON.stringify(body, null, 2));
}

async function runLocal({ dryRun }) {
  const sales = await import('../data/sales.js');
  if (dryRun) {
    const named = sales.previewNamedMeetingTimeBackfills();
    console.log(JSON.stringify({ dryRun: true, named, sms: { scanned: sales.getSalesClients().length } }, null, 2));
    return;
  }
  const sms = sales.backfillSmsRemindersToMeeting();
  const named = sales.applyNamedMeetingTimeBackfills();
  console.log(JSON.stringify({ dryRun: false, sms, named, note: 'Calendar + confirmation run on asoldi.com via --prod' }, null, 2));
}

async function main() {
  loadEnvFile(resolve(process.cwd(), '.env.local'));
  loadEnvFile(resolve(process.cwd(), '.env'));
  loadEnvFile(resolve(process.cwd(), '.env.hostinger-import'));
  const dryRun = process.argv.includes('--dry-run');
  if (process.argv.includes('--prod')) {
    await runProduction({ dryRun });
    return;
  }
  await runLocal({ dryRun });
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
