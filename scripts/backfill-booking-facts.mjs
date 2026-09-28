#!/usr/bin/env node
/**
 * Force-run booking-facts backfill.
 *
 *   node scripts/backfill-booking-facts.mjs
 *     Local ~/.asoldi-website-data (or APP_DATA_DIR) + MyPhoner API.
 *
 *   node scripts/backfill-booking-facts.mjs --prod
 *     POST /api/admin/sales/backfill-booking-facts on asoldi.com (live cards).
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

async function backfillProduction() {
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
  const res = await fetch(`${baseUrl}/api/admin/sales/backfill-booking-facts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${loginBody.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ force: true }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Backfill failed (${res.status}): ${body.message || 'error'}`);
  }
  console.log(`[prod] ${baseUrl} scanned=${body.scanned} updated=${body.updated} fetched=${body.fetched} failed=${body.failed} stillMissing=${body.stillMissing}`);
}

async function main() {
  loadEnvFile(resolve(process.cwd(), '.env.local'));
  loadEnvFile(resolve(process.cwd(), '.env'));
  loadEnvFile(resolve(process.cwd(), '.env.hostinger-import'));
  loadEnvFile(resolve(process.cwd(), '../website-maker/.env.local'));
  if (process.argv.includes('--prod')) {
    await backfillProduction();
    return;
  }
    const sales = await import('../data/sales.js');
    const myphonerApi = await import('../lib/myphoner-api.js');
    const store = await import('../data/store.js');
    const { extractBookingFromLead, salesBookingFacts } = await import('../lib/sales-booking-facts.js');
    const { getPersistentDataDir } = await import('../data/storage-path.js');

    function sanitizeText(value = '') {
      return String(value ?? '').trim();
    }
    function normalizeEmail(value = '') {
      return sanitizeText(value).toLowerCase();
    }

    const summary = { scanned: 0, updated: 0, fetched: 0, failed: 0, stillMissing: 0 };
    const users = await store.getAllUsers().catch(() => []);
    const nameByEmail = new Map();
    for (const user of users) {
      const email = normalizeEmail(user?.username || user?.email || user?.fromEmail);
      const name = sanitizeText(user?.name);
      if (email && name && !nameByEmail.has(email)) nameByEmail.set(email, name);
    }
    const patches = [];
    for (const client of sales.getSalesClients()) {
      summary.scanned += 1;
      const my = client.myphoner || {};
      let bookedByEmail = sanitizeText(my.bookedByEmail) || sanitizeText(my.latestCallUserEmail);
      let bookedByName = sanitizeText(my.bookedByName);
      let bookedAt = sanitizeText(my.bookedAt);
      let listName = sanitizeText(my.listName);
      let listId = sanitizeText(my.listId);
      const leadId = sanitizeText(my.leadId);
      const missing = !(bookedByEmail || bookedByName) || !bookedAt || !listName;
      let fetchFailed = false;
      if (leadId && missing && myphonerApi.isMyPhonerConfigured()) {
        summary.fetched += 1;
        const leadRes = await myphonerApi.fetchMyPhonerLeadById(leadId);
        if (!leadRes.success) {
          fetchFailed = true;
          summary.failed += 1;
        } else {
          let lead = myphonerApi.unwrapMyPhonerLead(leadRes.data);
          let extracted = extractBookingFromLead(lead);
          if (!(extracted.bookedByEmail || extracted.bookedByName)) {
            const eventsRes = await myphonerApi.fetchMyPhonerLeadEvents(leadId);
            const eventRows = Array.isArray(eventsRes?.data)
              ? eventsRes.data
              : Array.isArray(eventsRes?.data?.events)
                ? eventsRes.data.events
                : [];
            if (eventsRes?.success && eventRows.length) {
              lead = { ...lead, events: eventRows };
              extracted = extractBookingFromLead(lead);
            }
          }
          if (!bookedByEmail) bookedByEmail = sanitizeText(extracted.bookedByEmail);
          if (!bookedByName) bookedByName = sanitizeText(extracted.bookedByName);
          if (!bookedAt) bookedAt = sanitizeText(extracted.bookedAt);
          if (!listName && extracted.listName) listName = sanitizeText(extracted.listName);
          if (!listId && extracted.listId) listId = sanitizeText(extracted.listId);
          if (!(bookedByEmail || bookedByName) && sanitizeText(my.latestCallId)) {
            const callRes = await myphonerApi.fetchMyPhonerCallById(my.latestCallId);
            if (callRes.success) {
              const fromCall = extractBookingFromLead(lead, callRes.data);
              if (fromCall.bookedByEmail) bookedByEmail = sanitizeText(fromCall.bookedByEmail);
              if (fromCall.bookedByName) bookedByName = sanitizeText(fromCall.bookedByName);
            }
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      if (fetchFailed) continue;
      if (!bookedByName && bookedByEmail) bookedByName = nameByEmail.get(bookedByEmail) || '';
      if (!bookedAt && leadId) bookedAt = sanitizeText(client.createdAt);
      if (!(bookedByEmail || bookedByName) || !bookedAt || !listName) summary.stillMissing += 1;
      const myphonerPatch = {};
      if (bookedByEmail && bookedByEmail !== sanitizeText(my.bookedByEmail)) myphonerPatch.bookedByEmail = bookedByEmail;
      if (bookedByName && bookedByName !== sanitizeText(my.bookedByName)) myphonerPatch.bookedByName = bookedByName;
      if (bookedAt && bookedAt !== sanitizeText(my.bookedAt)) myphonerPatch.bookedAt = bookedAt;
      if (listName && listName !== sanitizeText(my.listName)) myphonerPatch.listName = listName;
      if (listId && listId !== sanitizeText(my.listId)) myphonerPatch.listId = listId;
      if (Object.keys(myphonerPatch).length) {
        patches.push({
          id: client.id,
          patch: {
            myphoner: myphonerPatch,
            salesMigrations: { ...(client.salesMigrations || {}), bookingFactsV1: true, bookingFactsV2: true },
          },
        });
      }
    }
    summary.updated = sales.patchSalesClientsById(patches).updated;
    console.log(`[local] ${getPersistentDataDir()} scanned=${summary.scanned} updated=${summary.updated} fetched=${summary.fetched} failed=${summary.failed} stillMissing=${summary.stillMissing} alreadyHadBooker=${sales.getSalesClients().filter((c) => salesBookingFacts(c).booker).length}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
