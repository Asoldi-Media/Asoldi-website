#!/usr/bin/env node
/**
 * Move Bård Fransson leads booked before 11.08.2026 onto Alexander Farkas,
 * and move Alexander's other clients to damian@asoldi.com. No confirmation emails.
 *
 *   node scripts/reassign-baard-farkas.mjs
 *     Dry-run against local data dir.
 *
 *   node scripts/reassign-baard-farkas.mjs --apply
 *     Write local sales-clients.json.
 *
 *   node scripts/reassign-baard-farkas.mjs --prod
 *     Dry-run on asoldi.com.
 *
 *   node scripts/reassign-baard-farkas.mjs --prod --apply
 *     Apply on asoldi.com.
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

function printPlan(plan, extra = {}) {
  console.log(JSON.stringify({
    dryRun: extra.dryRun !== false,
    updated: extra.updated ?? 0,
    cutoffYmd: plan.cutoffYmd,
    alexander: plan.alexander,
    damianOwnerKey: plan.damianOwnerKey,
    toAlexander: plan.toAlexander.length,
    toDamian: plan.toDamian.length,
    movedToAlexander: plan.toAlexander.map((row) => ({
      id: row.id,
      businessName: row.businessName,
      bookedAt: row.bookedAt || '',
      fromOwnerId: row.fromOwnerId,
      toOwnerId: row.toOwnerId,
    })),
    movedToDamian: plan.toDamian.map((row) => ({
      id: row.id,
      businessName: row.businessName,
      bookedAt: row.bookedAt || '',
      fromOwnerId: row.fromOwnerId,
      toOwnerId: row.toOwnerId,
    })),
  }, null, 2));
}

async function adminLogin(baseUrl) {
  const username = process.env.PROD_ADMIN_USERNAME || process.env.ADMIN_USERNAME || 'asoldi.com';
  const password = process.env.PROD_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD;
  if (!password) {
    throw new Error('Set PROD_ADMIN_PASSWORD or ADMIN_PASSWORD.');
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
  return loginBody.token;
}

async function fetchJson(baseUrl, token, path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

function printRemotePlan(label, plan, extra = {}) {
  console.log(`[${label}] dryRun=${extra.dryRun !== false} toAlexander=${plan.toAlexander.length} toDamian=${plan.toDamian.length} updated=${extra.updated ?? 0}`);
  printPlan(plan, extra);
}

async function planFromLiveReads(baseUrl, token) {
  const { planBaardFarkasReassign } = await import('../lib/sales-baard-farkas-assign.js');
  const usersRes = await fetchJson(baseUrl, token, '/api/admin/users');
  if (!usersRes.res.ok || !Array.isArray(usersRes.body)) {
    throw new Error(`GET /api/admin/users failed (${usersRes.res.status})`);
  }
  const salesRes = await fetchJson(baseUrl, token, '/api/admin/sales');
  if (!salesRes.res.ok) {
    throw new Error(`GET /api/admin/sales failed (${salesRes.res.status}): ${salesRes.body.message || 'error'}`);
  }
  const clients = Array.isArray(salesRes.body.clients) ? salesRes.body.clients : [];
  const plan = planBaardFarkasReassign(clients, usersRes.body);
  if (plan.error) throw new Error(plan.error);
  return { plan, clients, users: usersRes.body };
}

const HOSTINGER_USER = 'u439392007';
const HOSTINGER_DOMAIN = 'asoldi.com';
const PATCH_PY_NAME = '_baard_farkas_once.py';

async function hostingerApi(pathname, { method = 'GET', body } = {}) {
  const token = process.env.HOSTINGER_API_TOKEN;
  if (!token) throw new Error('Set HOSTINGER_API_TOKEN to patch asoldi.com disk.');
  const response = await fetch(`https://developers.hostinger.com${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 4000) };
  }
  return { status: response.status, data };
}

async function hostingerCron(command, waitMs = 110000) {
  if (command.length > 255) throw new Error(`cron too long ${command.length}: ${command}`);
  const created = await hostingerApi(`/api/hosting/v1/accounts/${HOSTINGER_USER}/cron-jobs`, {
    method: 'POST',
    body: { time: '* * * * *', command },
  });
  const uid = created.data?.uid;
  if (!uid) throw new Error(`cron create failed: ${JSON.stringify(created).slice(0, 800)}`);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  const output = await hostingerApi(`/api/hosting/v1/accounts/${HOSTINGER_USER}/cron-jobs/${uid}/output`);
  await hostingerApi(`/api/hosting/v1/accounts/${HOSTINGER_USER}/cron-jobs/${uid}`, { method: 'DELETE' });
  return String(output.data?.output || JSON.stringify(output.data || {}));
}

function buildDiskPatchPython(plan) {
  const moves = {};
  for (const row of [...(plan.toAlexander || []), ...(plan.toDamian || [])]) {
    if (row?.id && row?.toOwnerId) moves[row.id] = row.toOwnerId;
  }
  return `#!/usr/bin/env python3
import json, os, time
from pathlib import Path
MOVES = ${JSON.stringify(moves)}
CANDIDATES = [
  Path("/home/${HOSTINGER_USER}/domains/${HOSTINGER_DOMAIN}/.asoldi-website-data/sales-clients.json"),
  Path("/home/${HOSTINGER_USER}/.asoldi-website-data/sales-clients.json"),
  Path("/home/${HOSTINGER_USER}/domains/${HOSTINGER_DOMAIN}/nodejs/.asoldi-website-data/sales-clients.json"),
]
now = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
stamp = time.strftime("%Y%m%dT%H%M%S", time.gmtime())
report = []
for path in CANDIDATES:
  if not path.exists():
    continue
  data = json.loads(path.read_text(encoding="utf-8"))
  if not isinstance(data, list):
    continue
  ids = {row.get("id") for row in data if isinstance(row, dict)}
  if not any(item in ids for item in MOVES):
    continue
  backup = path.with_name(path.name + ".baard-farkas." + stamp + ".bak")
  backup.write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
  updated = 0
  missing = []
  by_id = {row.get("id"): row for row in data if isinstance(row, dict)}
  for client_id, owner in MOVES.items():
    row = by_id.get(client_id)
    if not row:
      missing.append(client_id)
      continue
    if row.get("ownerId") != owner:
      row["ownerId"] = owner
      row["updatedAt"] = now
      updated += 1
  tmp = path.with_name(path.name + ".tmp")
  tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\\n", encoding="utf-8")
  os.replace(tmp, path)
  report.append({"path": str(path), "backup": str(backup), "updated": updated, "missing": missing, "size": path.stat().st_size})
print(json.dumps({"files": report, "moves": len(MOVES)}))
`;
}

async function uploadPublicHtmlFile(fileName, contents) {
  const upload = await hostingerApi('/api/hosting/v1/files/upload-urls', {
    method: 'POST',
    body: { username: HOSTINGER_USER, domain: HOSTINGER_DOMAIN },
  });
  if (!upload?.data?.url) {
    throw new Error(`upload-urls failed: ${JSON.stringify(upload).slice(0, 800)}`);
  }
  const dest = `${String(upload.data.url).replace(/\/$/, '')}/${fileName}?override=true`;
  const tusHeaders = {
    'X-Auth': upload.data.auth_key,
    'X-Auth-Rest': upload.data.rest_auth_key,
    'Tus-Resumable': '1.0.0',
  };
  const buffer = Buffer.from(contents, 'utf8');
  const created = await fetch(dest, {
    method: 'POST',
    headers: { ...tusHeaders, 'Upload-Length': String(buffer.length), 'Upload-Offset': '0' },
  });
  if (created.status !== 201 && created.status !== 204 && created.status !== 200) {
    throw new Error(`tus create failed (${created.status})`);
  }
  const patched = await fetch(dest, {
    method: 'PATCH',
    headers: {
      ...tusHeaders,
      'Content-Type': 'application/offset+octet-stream',
      'Upload-Offset': '0',
    },
    body: buffer,
  });
  if (patched.status >= 300) throw new Error(`tus patch failed (${patched.status})`);
}

async function applyViaHostingerDisk(plan) {
  const pyPath = `/home/${HOSTINGER_USER}/domains/${HOSTINGER_DOMAIN}/public_html/${PATCH_PY_NAME}`;
  await uploadPublicHtmlFile(PATCH_PY_NAME, buildDiskPatchPython(plan));
  const output = await hostingerCron(`python3 ${pyPath}; rm -f ${pyPath}`);
  let parsed = null;
  try {
    const start = output.indexOf('{');
    parsed = start >= 0 ? JSON.parse(output.slice(start)) : null;
  } catch {
    parsed = null;
  }
  return { output, parsed };
}

async function runProduction(apply) {
  const baseUrl = String(process.env.PROD_ADMIN_URL || 'https://asoldi.com').replace(/\/$/, '');
  const token = await adminLogin(baseUrl);
  const endpoint = await fetchJson(baseUrl, token, '/api/admin/sales/reassign-baard-farkas', {
    method: 'POST',
    body: { dryRun: !apply },
  });
  if (endpoint.res.ok) {
    const body = endpoint.body;
    console.log(`[prod] ${baseUrl} dryRun=${body.dryRun} toAlexander=${body.toAlexander} toDamian=${body.toDamian} updated=${body.updated}`);
    console.log(JSON.stringify({
      alexander: body.alexander,
      damianOwnerKey: body.damianOwnerKey,
      movedToAlexander: body.movedToAlexander || [],
      movedToDamian: body.movedToDamian || [],
    }, null, 2));
    return;
  }
  if (endpoint.res.status !== 404) {
    throw new Error(`Reassign failed (${endpoint.res.status}): ${endpoint.body.message || 'error'}`);
  }
  const { plan } = await planFromLiveReads(baseUrl, token);
  if (!apply) {
    console.log(`[prod-read] ${baseUrl} endpoint missing; planned from live Users + sales clients.`);
    printRemotePlan('prod-read', plan, { dryRun: true, updated: 0 });
    return;
  }
  if (!plan.toAlexander.length && !plan.toDamian.length) {
    printRemotePlan('prod-disk', plan, { dryRun: false, updated: 0 });
    return;
  }
  console.log(`[prod-disk] applying ${plan.toAlexander.length + plan.toDamian.length} silent owner patches on Hostinger disk.`);
  printRemotePlan('prod-disk-plan', plan, { dryRun: false, updated: 0 });
  const applied = await applyViaHostingerDisk(plan);
  console.log('[prod-disk-result]', applied.parsed || applied.output.slice(0, 4000));
  const after = await planFromLiveReads(baseUrl, token);
  printRemotePlan('prod-after', after.plan, { dryRun: false, updated: applied.parsed?.files?.reduce((sum, file) => sum + (file.updated || 0), 0) || 0 });
  if (after.plan.toAlexander.length || after.plan.toDamian.length) {
    throw new Error('Live sales list still has leftover moves after disk patch.');
  }
}

async function runLocal(apply) {
  const sales = await import('../data/sales.js');
  const store = await import('../data/store.js');
  const {
    baardFarkasPatchEntries,
    planBaardFarkasReassign,
  } = await import('../lib/sales-baard-farkas-assign.js');
  const users = await store.getAllUsers();
  const plan = planBaardFarkasReassign(sales.getSalesClients(), users);
  if (plan.error) throw new Error(plan.error);
  if (apply) {
    const applied = sales.applySilentOwnerPatches(baardFarkasPatchEntries(plan));
    printPlan(plan, { dryRun: false, updated: applied.updated });
    return;
  }
  printPlan(plan, { dryRun: true, updated: 0 });
}

async function main() {
  loadEnvFile(resolve(process.cwd(), '.env.local'));
  loadEnvFile(resolve(process.cwd(), '.env'));
  loadEnvFile(resolve(process.cwd(), '../website-maker/.env.local'));
  const apply = process.argv.includes('--apply');
  if (process.argv.includes('--prod')) {
    await runProduction(apply);
    return;
  }
  await runLocal(apply);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
