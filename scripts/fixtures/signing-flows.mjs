// HTTP flows over every signing path, for a hub booted (scripts/safe-mode/hub-boot.mjs) on the data
// scripts/fixtures/signing-seed.mjs wrote. Used by the signing tests with the switch off, in shadow and
// in auto, and by the comparison with an older hub build. Only HTTP and the seed folder: it imports no
// hub data module, so it runs the same against any build.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Stripe from 'stripe';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SEED_SCRIPT = join(HERE, 'signing-seed.mjs');
export const STRIPE_WEBHOOK_SECRET = 'whsec_signing_test_local_only';
export const CALLBACK_TOKEN = 'signing-test-callback-token-local-only';
export const BOOT_ENV = Object.freeze({
  HUB_SAFE_MODE: '1',
  STRIPE_SECRET_KEY: 'sk_test_signing_local_only',
  STRIPE_WEBHOOK_SECRET,
  WEBSITE_MAKER_STATUS_CALLBACK_TOKEN: CALLBACK_TOKEN,
});

/** Seeds `dir` in a child process (the data modules bind their folder at load). */
export function seedSigningData(dir, { repo = join(HERE, '..', '..') } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'signing-seed-cwd-'));
  const env = { ...process.env, APP_DATA_DIR: dir, DATA_DIR: '' };
  for (const key of Object.keys(env)) if (/^(HUB_SAFE_MODE|ADMIN_)/.test(key)) delete env[key];
  const out = spawnSync(process.execPath, [join(repo, 'scripts', 'fixtures', 'signing-seed.mjs'), dir], { cwd, env, encoding: 'utf8', timeout: 60_000 });
  rmSync(cwd, { recursive: true, force: true });
  if (out.status !== 0) throw new Error(`signing seed failed: ${out.stderr || out.stdout}`);
  return JSON.parse(out.stdout.trim().split('\n').pop());
}

async function json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 200) };
  }
}

/** Runs every flow once; returns { steps: {name: {status, body}} } in order. */
export async function runSigningFlows(hub, seed, { token }) {
  const C = seed.clients;
  const steps = {};
  const admin = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const call = async (name, method, path, { headers = admin, body } = {}) => {
    const res = await fetch(`${hub.base}${path}`, { method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    steps[name] = { status: res.status, body: await json(res) };
    return steps[name];
  };

  // Client accounts for the portal paths (the portal offers target these addresses).
  const portalUser = await call('register-portal', 'POST', '/api/client-auth/register', { headers: { 'content-type': 'application/json' }, body: { email: `${C.portal}@example.com`, password: 'Portal-local-1234' } });
  const portalFreshUser = await call('register-portal-fresh', 'POST', '/api/client-auth/register', { headers: { 'content-type': 'application/json' }, body: { email: `${C.portalFresh}@example.com`, password: 'Fresh-local-1234' } });
  const upgradeUser = await call('register-upgrade', 'POST', '/api/client-auth/register', { headers: { 'content-type': 'application/json' }, body: { email: `${C.upgrade}@example.com`, password: 'Upgrade-local-1234' } });

  await call('connect-upgrade', 'POST', `/api/admin/sales/${C.upgrade}/connect-portal`, { body: {} });
  await call('progression', 'PATCH', `/api/admin/sales/${C.progress}/progression`, { body: { key: 'contractSigned', value: true } });
  await call('progression-again', 'PATCH', `/api/admin/sales/${C.progress}/progression`, { body: { key: 'contractSigned', value: true } });
  await call('progression-ssu', 'PATCH', `/api/admin/sales/${C.ssu}/progression`, { body: { key: 'contractSigned', value: true } });
  await call('progression-dual', 'PATCH', `/api/admin/sales/${C.dual}/progression`, { body: { key: 'contractSigned', value: true } });
  await call('progression-nonpilot', 'PATCH', `/api/admin/sales/${C.nonPilot}/progression`, { body: { key: 'contractSigned', value: true } });
  await call('got-client', 'POST', `/api/admin/sales/${C.gotClient}/got-client`, { body: {} });
  await call('got-client-same-domain', 'POST', `/api/admin/sales/${C.gotDup}/got-client`, { body: {} });
  await call('preview-accept', 'POST', `/api/public/sales-preview/${C.preview}/contract/accept`, {
    headers: { 'content-type': 'application/json' },
    body: { accepted: true, termsAccepted: true, bindingAccepted: true, name: 'Kari Example', password: 'Preview-local-1234' },
  });
  await call('portal-accept', 'POST', '/api/client/offer/accept', { headers: { authorization: `Bearer ${portalUser.body.token}`, 'content-type': 'application/json' }, body: {} });
  await call('portal-accept-fresh', 'POST', '/api/client/offer/accept', { headers: { authorization: `Bearer ${portalFreshUser.body.token}`, 'content-type': 'application/json' }, body: {} });
  await call('portal-accept-upgrade', 'POST', '/api/client/offer/accept', { headers: { authorization: `Bearer ${upgradeUser.body.token}`, 'content-type': 'application/json' }, body: {} });

  const stripe = new Stripe('sk_test_signing_local_only');
  const webhook = async (name, session) => {
    const payload = JSON.stringify({ id: `evt_${name}`, object: 'event', type: 'checkout.session.completed', data: { object: session } });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: STRIPE_WEBHOOK_SECRET });
    return call(name, 'POST', '/api/webhooks/stripe', { headers: { 'content-type': 'application/json', 'stripe-signature': signature }, body: payload });
  };
  await webhook('stripe-offer', { id: 'cs_test_offer', object: 'checkout.session', amount_total: 199900, currency: 'nok', metadata: { salesClientId: C.stripe, offerId: 'so-stripe', contractHash: seed.contractHash, planId: 'tier-3-ecommerce' } });
  await webhook('stripe-no-offer', { id: 'cs_test_plain', object: 'checkout.session', amount_total: 199900, currency: 'nok', metadata: { salesClientId: C.stripeNone, planId: 'tier-3-ecommerce' } });

  await call('signed-contract-backfill', 'POST', '/api/admin/sales/signed-contract-backfill', { body: { apply: true, confirm: 'backfill-once' } });

  // Go-live status from the Maker, schema 2 (an older hub reads the same body as before).
  const callback = { 'content-type': 'application/json', 'x-sales-callback-token': CALLBACK_TOKEN };
  await call('golive', 'POST', '/api/admin/sales/maker-status-callback', {
    headers: callback,
    body: { event: 'run.golive.updated', schema: 2, target: 'production', status: 'ready', liveVerifiedAt: '', runId: 'run-progress', salesClientId: C.progress, domain: 'progress.example.com', liveUrl: 'https://progress.example.com', siteKey: 'maker-key-progress', githubRepo: 'Example-Org/website---progress', hubSite: { site_key: 'maker-key-progress', domain: 'progress.example.com', name: 'Progress Example AS', githubRepo: 'Example-Org/website---progress' } },
  });

  // A Superadmin changes the plan on the got-client site.
  const gotSite = steps['got-client']?.body?.site?.id;
  if (gotSite) await call('site-plan-edit', 'PUT', `/api/hub/sites/${encodeURIComponent(gotSite)}`, { body: { websitePlan: 'tier-2-seo' } });
  return steps;
}

/** Waits until the outbox stops growing (mails sent without waiting land a little later). */
export async function settledOutbox(dataDir, { quietMs = 1500, maxMs = 15_000 } = {}) {
  const file = join(dataDir, 'outbox', 'index.jsonl');
  const read = () => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  const started = Date.now();
  let rows = read();
  let stableSince = Date.now();
  while (Date.now() - started < maxMs) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const next = read();
    if (next.length !== rows.length) {
      rows = next;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) {
      break;
    }
  }
  return rows;
}

export function readJsonFile(dir, name, fallback = null) {
  const file = join(dir, name);
  if (!existsSync(file)) return fallback;
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return parsed;
}

/** GET /api/hub/site-config for every site in the data folder, keyed by site id. */
export async function siteConfigs(hub) {
  const sites = readJsonFile(hub.dataDir, 'sites.json', []);
  const out = {};
  for (const site of sites) {
    const res = await fetch(`${hub.base}/api/hub/site-config?site_key=${encodeURIComponent(site.site_key)}`);
    out[site.id] = { status: res.status, body: await json(res) };
  }
  return out;
}
