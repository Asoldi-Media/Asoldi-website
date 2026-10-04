import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cityFromSalesClient,
  discoverSalesLinks,
  isUpcomingSalesClient,
  readPublicPage,
  searchGoogle,
} from '../lib/sales-link-discovery.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const makerRoot = resolve(root, '..', 'website-maker');

function loadEnv(filePath) {
  if (!existsSync(filePath)) return;
  for (const rawLine of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

for (const file of [
  join(root, '.env'),
  join(root, '.env.local'),
  join(makerRoot, '.env'),
  join(makerRoot, '.env.local'),
]) {
  loadEnv(file);
}

const listOnly = process.argv.includes('--list');
const applyApi = process.argv.includes('--apply-api');

function envMap(filePath) {
  if (!existsSync(filePath)) return {};
  return Object.fromEntries(
    readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.includes('=') && !line.trim().startsWith('#'))
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
      })
  );
}

const loginEnv = {
  ...envMap(join(makerRoot, '.env.local')),
  ...envMap(join(root, '.env')),
};

async function productionClients() {
  const login = await fetch('https://asoldi.com/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: loginEnv.PROD_ADMIN_USERNAME,
      password: loginEnv.PROD_ADMIN_PASSWORD,
    }),
  });
  const body = await login.json().catch(() => ({}));
  if (!login.ok || !body.token) {
    throw new Error(body.message || `Login failed (${login.status})`);
  }
  const response = await fetch('https://asoldi.com/api/admin/sales', {
    headers: { Authorization: `Bearer ${body.token}`, Accept: 'application/json' },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || `Sales list failed (${response.status})`);
  const clients = Array.isArray(payload) ? payload : (payload.clients || []);
  return { token: body.token, clients };
}

function linkSnapshot(client = {}) {
  const details = client.details || {};
  return {
    instagramUrl: String(details.instagramUrl || '').trim(),
    facebookUrl: String(details.facebookUrl || '').trim(),
    websiteDomain: String(client.websiteDomain || '').trim(),
    googleBusinessProfile: String(details.googleBusinessProfile || '').trim(),
  };
}

let lastSearchAt = 0;
async function pacedSearch(query) {
  const wait = Math.max(0, 900 - (Date.now() - lastSearchAt));
  if (wait) await new Promise((resolveWait) => setTimeout(resolveWait, wait));
  lastSearchAt = Date.now();
  return searchGoogle(query);
}

const { token, clients } = await productionClients();
const upcoming = clients.filter((client) => isUpcomingSalesClient(client));
console.log(`sales=${clients.length} upcoming=${upcoming.length}`);
for (const client of upcoming) {
  const links = linkSnapshot(client);
  const filled = ['instagramUrl', 'facebookUrl', 'websiteDomain', 'googleBusinessProfile'].filter((field) => links[field]).length;
  console.log(`${client.businessName} | meeting=${client.meetingAt || 'none'} | filled=${filled}/4`);
}
if (listOnly) process.exit(0);

const report = [];
for (const client of upcoming) {
  const before = linkSnapshot(client);
  process.stdout.write(`\n${client.businessName} ... `);
  let discovered;
  try {
    discovered = await discoverSalesLinks({
    businessName: client.businessName,
    city: cityFromSalesClient(client),
    phone: client.contactPhone,
    orgNumber: client.orgNumber,
    address: client.businessAddress || client.meetingPlace,
    websiteDomain: client.websiteDomain,
    instagramUrl: before.instagramUrl,
    facebookUrl: before.facebookUrl,
    googleBusinessProfile: before.googleBusinessProfile,
  }, {
    search: pacedSearch,
    readPage: readPublicPage,
  });
  } catch (error) {
    console.log(`failed: ${error?.message || error}`);
    report.push({
      id: client.id,
      businessName: client.businessName,
      before,
      after: before,
      reasons: { error: String(error?.message || error) },
    });
    continue;
  }
  const after = {
    instagramUrl: discovered.instagramUrl || '',
    facebookUrl: discovered.facebookUrl || '',
    websiteDomain: discovered.websiteDomain || '',
    googleBusinessProfile: discovered.googleBusinessProfile || '',
  };
  const reasons = {
    instagram: discovered.diagnostics?.instagram?.reason || '',
    facebook: discovered.diagnostics?.facebook?.reason || '',
    website: discovered.diagnostics?.website?.reason || '',
    maps: discovered.diagnostics?.maps?.reason || '',
    gemini: discovered.diagnostics?.gemini?.reason || '',
  };
  console.log(`ig=${after.instagramUrl ? 'yes' : 'no'} fb=${after.facebookUrl ? 'yes' : 'no'} web=${after.websiteDomain ? 'yes' : 'no'} maps=${after.googleBusinessProfile ? 'yes' : 'no'}`);
  report.push({
    id: client.id,
    businessName: client.businessName,
    before,
    after,
    reasons,
  });
}

const reportPath = join(root, 'tmp', 'upcoming-link-refresh.json');
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`\nreport ${reportPath}`);

if (applyApi) {
  const response = await fetch('https://asoldi.com/api/admin/sales/refresh-upcoming-links', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ clientIds: upcoming.map((client) => client.id) }),
  });
  const payload = await response.json().catch(() => ({}));
  console.log('apply', response.status, payload.message || payload.count || '');
}
