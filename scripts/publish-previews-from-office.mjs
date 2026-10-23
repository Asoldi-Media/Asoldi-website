// Publish Website Maker sites onto asoldi.com/sales-preview from an office PC.
//
// Browsers block https://asoldi.com from fetching the office HTTP Maker
// directly (mixed content), so this script does the copying server-side:
//   Maker export ZIP  ->  POST https://asoldi.com/api/admin/sales/:id/receive-preview-bundle
//
// Usage (on a PC that can reach Website Maker):
//   node scripts/publish-previews-from-office.mjs            # publish once
//   node scripts/publish-previews-from-office.mjs --loop     # keep publishing every 5 min
//   node scripts/publish-previews-from-office.mjs --maker http://localhost:3000
//
// The same logic runs automatically inside the office Docker Asoldi server
// (docker-compose.lan.yml), so this script is only needed when that stack is
// not running.

import { buildMakerExportUrl, buildPublicSalesPreviewUrl } from '../lib/laptop-preview.js';

const args = process.argv.slice(2);
function argValue(flag, fallback = '') {
  const index = args.indexOf(flag);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return fallback;
}

const PROD_BASE = (argValue('--prod', process.env.PROD_ADMIN_URL || 'https://asoldi.com')).replace(/\/+$/, '');
const MAKER_BASE = (argValue('--maker', process.env.WEBSITE_MAKER_BASE_URL || 'http://192.168.68.92:3000')).replace(/\/+$/, '');
const USERNAME = argValue('--username', process.env.PROD_ADMIN_USERNAME || 'asoldi.com');
const PASSWORD = argValue('--password', process.env.PROD_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || '');
if (!PASSWORD) {
  console.error('Set PROD_ADMIN_PASSWORD (asoldi.com/admin password) or pass --password.');
  process.exit(1);
}
const LOOP = args.includes('--loop');
const INTERVAL_MS = Math.max(60_000, Number(argValue('--interval', '')) || 5 * 60_000);
const MAKER_API_KEY = String(process.env.WEBSITE_MAKER_API_KEY || '').trim();

function makerHeaders() {
  return MAKER_API_KEY ? { 'x-api-key': MAKER_API_KEY } : {};
}

async function login() {
  const res = await fetch(`${PROD_BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.token) {
    throw new Error(body.message || `Login to ${PROD_BASE}/admin failed (${res.status})`);
  }
  return body.token;
}

async function listTargets(token) {
  const headers = { Authorization: `Bearer ${token}` };
  const targets = new Map();

  const missingRes = await fetch(`${PROD_BASE}/api/admin/sales/preview-backfill`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  const missing = await missingRes.json().catch(() => ({}));
  if (!missingRes.ok) throw new Error(missing.message || `preview-backfill failed (${missingRes.status})`);
  for (const entry of missing.clients || []) {
    if (entry?.id && entry?.runId) {
      targets.set(entry.id, { id: entry.id, runId: entry.runId, businessName: entry.businessName || 'site' });
    }
  }

  const allRes = await fetch(`${PROD_BASE}/api/admin/sales?product=asoldi`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  const all = await allRes.json().catch(() => ({}));
  if (allRes.ok) {
    for (const client of all.clients || []) {
      const runId = String(client?.makerRun?.runId || '').trim();
      if (!client?.id || !runId) continue;
      if (String(client?.status || '') === 'not-sold') continue;
      targets.set(client.id, { id: client.id, runId, businessName: client.businessName || 'site' });
    }
  }
  return [...targets.values()];
}

async function publishOne(token, target) {
  const exportUrl = buildMakerExportUrl({
    makerBaseUrl: MAKER_BASE,
    runId: target.runId,
    step: 'latest',
    siteFolder: target.businessName,
    clientId: target.id,
    persist: true,
  });
  const exportRes = await fetch(exportUrl, { headers: makerHeaders(), signal: AbortSignal.timeout(180_000) });
  const zip = Buffer.from(await exportRes.arrayBuffer());
  if (!exportRes.ok) {
    let message = `Maker export failed (${exportRes.status})`;
    try {
      message = JSON.parse(zip.toString('utf8')).error || message;
    } catch {
      // keep fallback
    }
    throw new Error(message);
  }
  const uploadRes = await fetch(`${PROD_BASE}/api/admin/sales/${encodeURIComponent(target.id)}/receive-preview-bundle`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/zip',
      'X-Source-Run-Id': target.runId,
      'X-Source-Step': 'latest',
      'X-Site-Folder': target.businessName,
    },
    body: zip,
    signal: AbortSignal.timeout(180_000),
  });
  const body = await uploadRes.json().catch(() => ({}));
  if (!uploadRes.ok) throw new Error(body.message || `Upload failed (${uploadRes.status})`);
  return body.publicPreviewUrl || buildPublicSalesPreviewUrl(target.id);
}

async function runOnce() {
  try {
    await fetch(MAKER_BASE, { signal: AbortSignal.timeout(6_000) });
  } catch {
    console.error(`[publish-previews] Website Maker is not reachable at ${MAKER_BASE}. Run this on a PC on the office network (or pass --maker http://localhost:3000).`);
    return false;
  }
  const token = await login();
  const targets = await listTargets(token);
  if (!targets.length) {
    console.log('[publish-previews] nothing to publish.');
    return true;
  }
  console.log(`[publish-previews] publishing ${targets.length} site(s) to ${PROD_BASE}/sales-preview…`);
  let ok = 0;
  for (const target of targets) {
    try {
      const url = await publishOne(token, target);
      ok += 1;
      console.log(`  OK   ${target.businessName} -> ${url}`);
    } catch (error) {
      console.error(`  FAIL ${target.businessName} (${target.id}): ${error.message}`);
    }
  }
  console.log(`[publish-previews] done: ${ok}/${targets.length} published.`);
  return ok === targets.length;
}

if (LOOP) {
  console.log(`[publish-previews] loop mode: every ${Math.round(INTERVAL_MS / 60000)} min (Ctrl+C to stop).`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await runOnce().catch((error) => console.error('[publish-previews] cycle failed:', error.message));
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
} else {
  const success = await runOnce().catch((error) => {
    console.error('[publish-previews] failed:', error.message);
    return false;
  });
  process.exit(success ? 0 : 1);
}
