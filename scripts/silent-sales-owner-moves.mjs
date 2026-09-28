#!/usr/bin/env node
/**
 * Move named sales clients between Damian and Alexander without confirmation emails.
 * Writes ownerId on disk. Does not call POST /owner or bulk assign.
 *
 *   node scripts/silent-sales-owner-moves.mjs --prod
 *   node scripts/silent-sales-owner-moves.mjs --prod --apply
 */
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import {
  damianOwnerKey,
  findAlexanderSalesUser,
  salesOwnerKeyForUser,
} from '../lib/sales-baard-farkas-assign.js';

const TO_DAMIAN_QUERIES = [
  'lundamo camping',
  'rolands betongservice',
  'trondheim leilighets hotell',
];
const TO_ALEXANDER_QUERIES = [
  'muldvarpen as',
  'nv renhold heyerdahl',
  'pokebutikk khogiani',
];

const HOSTINGER_USER = 'u439392007';
const HOSTINGER_DOMAIN = 'asoldi.com';
const PATCH_PY_NAME = '_silent_owner_once.py';

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

function normName(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function nameTokens(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .match(/[a-z0-9]+/g) || [];
}

function orderedTokensMatch(query, name) {
  const hay = normName(name);
  let from = 0;
  for (const token of nameTokens(query)) {
    const idx = hay.indexOf(token, from);
    if (idx === -1) return false;
    from = idx + token.length;
  }
  return true;
}

function findClientByQuery(clients, query) {
  const needle = normName(query);
  const scored = (Array.isArray(clients) ? clients : [])
    .map((client) => {
      const hay = normName(client?.businessName);
      let score = 0;
      if (hay === needle) score = 3;
      else if (hay.includes(needle) || needle.includes(hay)) score = 2;
      else if (orderedTokensMatch(query, client?.businessName)) score = 1;
      return { client, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  const tied = scored.filter((row) => row.score === best?.score);
  if (!best) return { error: `Fant ingen klient som matcher «${query}».` };
  if (tied.length > 1) {
    return {
      error: `«${query}» matcher flere: ${tied.map((row) => row.client.businessName).join(', ')}`,
    };
  }
  return { client: best.client };
}

async function adminLogin(baseUrl) {
  const username = process.env.PROD_ADMIN_USERNAME || process.env.ADMIN_USERNAME || 'asoldi.com';
  const password = process.env.PROD_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD;
  if (!password) throw new Error('Set PROD_ADMIN_PASSWORD or ADMIN_PASSWORD.');
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

async function fetchJson(baseUrl, token, path) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GET ${path} failed (${res.status}): ${body.message || 'error'}`);
  return body;
}

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

function buildDiskPatchPython(moves) {
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
  backup = path.with_name(path.name + ".silent-owner." + stamp + ".bak")
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

async function applyViaHostingerDisk(moves) {
  const pyPath = `/home/${HOSTINGER_USER}/domains/${HOSTINGER_DOMAIN}/public_html/${PATCH_PY_NAME}`;
  await uploadPublicHtmlFile(PATCH_PY_NAME, buildDiskPatchPython(moves));
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

function planNamedMoves(clients, users) {
  const alexander = findAlexanderSalesUser(users);
  if (!alexander) throw new Error('Fant ikke Alexander i admin Users.');
  const alexanderKey = salesOwnerKeyForUser(alexander);
  const damianKey = damianOwnerKey(users);
  const rows = [];
  const used = new Set();

  const add = (query, toOwnerId, bucket) => {
    const found = findClientByQuery(clients, query);
    if (found.error) throw new Error(found.error);
    const client = found.client;
    if (used.has(client.id)) throw new Error(`«${client.businessName}» ble valgt to ganger.`);
    used.add(client.id);
    rows.push({
      id: client.id,
      businessName: client.businessName,
      fromOwnerId: client.ownerId || '',
      toOwnerId,
      bucket,
      already: (client.ownerId || '') === toOwnerId,
    });
  };

  for (const query of TO_DAMIAN_QUERIES) add(query, damianKey, 'toDamian');
  for (const query of TO_ALEXANDER_QUERIES) add(query, alexanderKey, 'toAlexander');

  return {
    alexander: { id: alexander.id, username: alexander.username, name: alexander.name, ownerKey: alexanderKey },
    damianOwnerKey: damianKey,
    rows,
    moves: Object.fromEntries(rows.filter((row) => !row.already).map((row) => [row.id, row.toOwnerId])),
  };
}

async function verifyLive(baseUrl, token, plan) {
  const sales = await fetchJson(baseUrl, token, '/api/admin/sales');
  const byId = new Map((sales.clients || []).map((client) => [client.id, client]));
  const mismatches = [];
  for (const row of plan.rows) {
    const live = byId.get(row.id);
    if (!live) {
      mismatches.push(`${row.businessName}: missing`);
      continue;
    }
    if ((live.ownerId || '') !== row.toOwnerId) {
      mismatches.push(`${row.businessName}: owner ${live.ownerId} expected ${row.toOwnerId}`);
    }
  }
  return mismatches;
}

async function main() {
  loadEnvFile(resolve(process.cwd(), '.env.local'));
  loadEnvFile(resolve(process.cwd(), '.env'));
  loadEnvFile(resolve(process.cwd(), '../website-maker/.env.local'));
  const apply = process.argv.includes('--apply');
  const baseUrl = String(process.env.PROD_ADMIN_URL || 'https://asoldi.com').replace(/\/$/, '');
  const token = await adminLogin(baseUrl);
  const users = await fetchJson(baseUrl, token, '/api/admin/users');
  const sales = await fetchJson(baseUrl, token, '/api/admin/sales');
  const plan = planNamedMoves(sales.clients || [], users);
  console.log(JSON.stringify({
    dryRun: !apply,
    alexander: plan.alexander,
    damianOwnerKey: plan.damianOwnerKey,
    toDamian: plan.rows.filter((row) => row.bucket === 'toDamian').map((row) => ({
      businessName: row.businessName,
      fromOwnerId: row.fromOwnerId,
      toOwnerId: row.toOwnerId,
      already: row.already,
    })),
    toAlexander: plan.rows.filter((row) => row.bucket === 'toAlexander').map((row) => ({
      businessName: row.businessName,
      fromOwnerId: row.fromOwnerId,
      toOwnerId: row.toOwnerId,
      already: row.already,
    })),
    pending: Object.keys(plan.moves).length,
  }, null, 2));
  if (!apply) return;
  if (!Object.keys(plan.moves).length) {
    console.log('Nothing to change.');
    return;
  }
  const applied = await applyViaHostingerDisk(plan.moves);
  console.log('[disk]', applied.parsed || applied.output.slice(0, 2000));
  const mismatches = await verifyLive(baseUrl, token, plan);
  if (mismatches.length) {
    throw new Error(`Live owners did not match after silent patch:\n${mismatches.join('\n')}`);
  }
  console.log('Verified live: all six owners updated. No confirmation email path used.');
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
