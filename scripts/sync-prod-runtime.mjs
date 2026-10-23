#!/usr/bin/env node
/**
 * One-way mirror of live asoldi.com runtime data onto a local/LAN data dir.
 *
 * Production remains the source of truth for sales/client records.
 * This never writes back to asoldi.com. Code still publishes via git → Hostinger.
 *
 * Usage:
 *   node scripts/sync-prod-runtime.mjs --out-dir "$HOME/.asoldi-website-data"
 *   node scripts/sync-prod-runtime.mjs --out-dir C:\hosted\asoldi-data
 *   node scripts/sync-prod-runtime.mjs --out-dir C:\hosted\asoldi-data --only sales
 *
 * Never copies secrets/ (signing secrets, webhook secrets) or production.env: a local
 * copy of the prod data must not hold the prod signing secret or the prod env.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { pathToFileURL } from 'url';
import bcrypt from 'bcryptjs';

/** True for paths a local runtime copy must never write: secrets/ and production.env. */
export function isProtectedRuntimePath(filePath = '') {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  return /(^|\/)secrets(\/|$)/i.test(normalized) || /^production\.env$/i.test(basename(normalized)) || /(^|\/)cms\/private(\/|$)/i.test(normalized);
}

const DEFAULT_PROD_URL = 'https://asoldi.com';
const DEFAULT_OUT_DIR = resolve(homedir(), '.asoldi-website-data');

function argValue(flag, fallback = '') {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || !process.argv[idx + 1]) return fallback;
  return process.argv[idx + 1];
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

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

function readJsonArray(filePath) {
  if (!existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeJson(filePath, data) {
  if (isProtectedRuntimePath(filePath)) throw new Error(`refusing to write a protected path: ${basename(filePath)}`);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function productCounts(clients) {
  const counts = { asoldi: 0, ssu: 0, other: 0 };
  for (const client of clients) {
    const product = String(client?.product || 'asoldi').toLowerCase();
    if (product === 'ssu') counts.ssu += 1;
    else if (product === 'asoldi') counts.asoldi += 1;
    else counts.other += 1;
  }
  return counts;
}

async function adminLogin(baseUrl, username, password) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.token) {
    throw new Error(`Admin login failed (${res.status}): ${body.message || 'no token'}`);
  }
  return body.token;
}

async function fetchJson(baseUrl, token, path) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`GET ${path} failed (${res.status}): ${body.message || 'error'}`);
  }
  return body;
}

function publicToUserRecord(user, passwordHash) {
  const role = String(user.role || 'none').toLowerCase();
  const record = {
    id: String(user.id),
    username: String(user.username),
    passwordHash,
    createdAt: user.createdAt || new Date().toISOString(),
    role,
  };
  if (role === 'employee' && user.employeeProduct) {
    record.employeeProduct = user.employeeProduct;
  }
  return record;
}

async function syncUsers({ prodUrl, token, outDir, newUserPassword }) {
  const prodUsers = await fetchJson(prodUrl, token, '/api/admin/users');
  if (!Array.isArray(prodUsers)) throw new Error('Production /api/admin/users did not return a list');
  const outPath = join(outDir, 'users.json');
  const existing = readJsonArray(outPath);
  const byUsername = new Map(existing.map((u) => [String(u.username || '').toLowerCase(), u]));
  const next = [];
  let keptHash = 0;
  let hashedNew = 0;
  for (const user of prodUsers) {
    const prev = byUsername.get(String(user.username).toLowerCase());
    let passwordHash = prev?.passwordHash;
    if (typeof passwordHash === 'string' && passwordHash.startsWith('$2')) {
      keptHash += 1;
    } else {
      passwordHash = await bcrypt.hash(newUserPassword, 12);
      hashedNew += 1;
    }
    next.push(publicToUserRecord(user, passwordHash));
  }
  writeJson(outPath, next);
  console.log(`users: ${next.length} from ${prodUrl} → ${outPath} (kept hashes ${keptHash}, new ${hashedNew})`);
}

async function syncSales({ prodUrl, token, outDir }) {
  const payload = await fetchJson(prodUrl, token, '/api/admin/sales');
  const clients = Array.isArray(payload?.clients) ? payload.clients : [];
  const outPath = join(outDir, 'sales-clients.json');
  writeJson(outPath, clients);
  const counts = productCounts(clients);
  console.log(`sales: ${clients.length} clients (asoldi ${counts.asoldi}, ssu ${counts.ssu}) → ${outPath}`);
}

async function main() {
  const cwd = process.cwd();
  loadEnvFile(resolve(cwd, '.env.local'));
  loadEnvFile(resolve(cwd, '.env'));

  const only = String(argValue('--only', 'all')).toLowerCase();
  const prodUrl = argValue('--from', process.env.PROD_ADMIN_URL || DEFAULT_PROD_URL);
  const outDir = resolve(argValue('--out-dir', process.env.APP_DATA_DIR || DEFAULT_OUT_DIR));
  const username = process.env.PROD_ADMIN_USERNAME || process.env.ADMIN_USERNAME || 'asoldi.com';
  const password = process.env.PROD_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD;
  const newUserPassword = process.env.LAN_USER_SYNC_PASSWORD || password;

  if (!password) {
    throw new Error('Set PROD_ADMIN_PASSWORD or ADMIN_PASSWORD (asoldi.com/admin credentials).');
  }

  mkdirSync(outDir, { recursive: true });
  const token = await adminLogin(prodUrl, username, password);

  if (only === 'all' || only === 'users') {
    if (!newUserPassword) throw new Error('Set LAN_USER_SYNC_PASSWORD for newly created LAN users.');
    await syncUsers({ prodUrl, token, outDir, newUserPassword });
  }
  if (only === 'all' || only === 'sales') {
    await syncSales({ prodUrl, token, outDir });
  }
  if (hasFlag('--dry-run')) {
    console.log('Note: --dry-run is not implemented; files were written.');
  }
}

function isDirectRun() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
