// Batch 2 on the real hub (server.js), 127.0.0.1 only, from an empty working folder, with the egress
// recorder enforcing. Data: a synthetic data dir shaped like the live stores, or a copy of the
// folder named by DELIVERY_BOOT_DATA (only *.json files are copied; the copy is deleted afterwards).
//
// 1. Switches off (the defaults): boot and read; no plan, stage or planSource is written, no
//    migrations or audit folder appears, every site config equals the stored site, and a Maker
//    delivery event takes the old step-status path.
// 2. A backfill dry run through the route writes only its report.
// 3. development.makerEvents = record: the event is stored, without URLs.
// 4. migrations.deliveryBackfill = apply: the next boot applies; the boot after that skips (one-time),
//    also for a client that signs in between.
// 5. create-maker-run sends the plan in force to the Maker (a fake Maker on 127.0.0.1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALLOWLIST, AUDIT, REPO, freePort } from './safe-mode/hub-boot.mjs';

const ADMIN = 'delivery-boot-admin';
const ADMIN_PASSWORD = `delivery-boot-${Date.now()}-pw`;
const CALLBACK_TOKEN = `delivery-boot-callback-${Date.now()}`;
const STORES = ['sales-clients.json', 'sites.json', 'sales-offers.json'];

function syntheticData(dataDir) {
  const signed = { meetingHeld: true, offerSent: true, contractSigned: true };
  const tier2Product = { id: 'p-1', kind: 'tier', tierId: 'tier-2-seo', name: 'Nettside – SEO', pages: 7, includes: ['Full nettsideutvikling', 'Koble til eget domene'], priceExMva: 1499 };
  const clients = [
    { id: 'boot-live', product: 'asoldi', businessName: 'Boot Live AS', status: 'active', progression: { ...signed, domainConnected: true, live: true }, hubSite: { id: 'site-a', siteKey: 'boot-key-a', createdAt: '2026-05-01T10:00:00.000Z' }, makerRun: { runId: 'run-live', latestReadyStep: '2' } },
    { id: 'boot-signed', product: 'asoldi', businessName: 'Boot Signed AS', status: 'active', progression: signed, contractSignedAt: '2026-10-01T10:00:00.000Z', workshopAction: { name: 'Workshop', dueAt: '2026-10-30T10:00:00.000Z' }, makerRun: { runId: 'run-signed', latestReadyStep: '2' } },
    { id: 'boot-lead', product: 'asoldi', businessName: 'Boot Lead AS', status: 'active', progression: { meetingHeld: true } },
    { id: 'boot-ssu', product: 'ssu', businessName: 'Boot Ssu AS', status: 'active', progression: { meetingHeld: true } },
  ];
  const offers = [
    { id: 'boot-offer', salesClientId: 'boot-signed', status: 'sent', sentAt: '2026-09-30T10:00:00.000Z', tierId: 'tier-2-seo', email: { subject: 'Tilbud', html: '<p>Tilbud</p>' }, products: [tier2Product], alternatives: [{ products: [tier2Product], billing: 'month', tierId: 'tier-2-seo' }] },
    { id: 'boot-draft', salesClientId: 'boot-lead', status: 'draft', tierId: 'tier-1-standard', email: { subject: 'Utkast', html: '<p>Utkast</p>' }, products: [{ id: 'p-2', kind: 'tier', tierId: 'tier-1-standard', name: 'Nettside – Standard', priceExMva: 800 }] },
  ];
  const flags1 = { users: true, analytics: false, ecommerce: false, blog: false, socialSync: false, emailMarketing: false, general: false };
  const flags3 = { users: true, analytics: true, ecommerce: true, blog: true, socialSync: true, emailMarketing: true, general: true };
  const sites = [
    { id: 'site-a', site_key: 'boot-key-a', name: 'Site A', domain: 'site-a.example', websitePlan: 'tier-1-standard', features: flags1, deliveryPhase: 'client', createdAt: '2026-05-01T10:00:00.000Z' },
    { id: 'site-b', site_key: 'boot-key-b', name: 'Site B', domain: 'site-b.example', websitePlan: 'tier-3-ecommerce', features: flags3, ecommerceCatalogType: 'menu', deliveryPhase: 'client', createdAt: '2026-04-01T10:00:00.000Z' },
  ];
  writeFileSync(join(dataDir, 'sales-clients.json'), JSON.stringify(clients, null, 2));
  writeFileSync(join(dataDir, 'sales-offers.json'), JSON.stringify(offers, null, 2));
  writeFileSync(join(dataDir, 'sites.json'), JSON.stringify(sites, null, 2));
}

function seedData(dataDir) {
  const source = String(process.env.DELIVERY_BOOT_DATA || '').trim();
  if (!source) {
    syntheticData(dataDir);
    return 'synthetic';
  }
  for (const name of readdirSync(source)) {
    if (name.endsWith('.json')) copyFileSync(join(source, name), join(dataDir, name));
  }
  return 'copy';
}

async function startHub(dataDir) {
  const port = await freePort();
  const runDir = mkdtempSync(join(tmpdir(), 'asoldi-delivery-boot-cwd-'));
  const shell = { ...process.env };
  for (const key of Object.keys(shell)) {
    if (/^(HUB_SAFE_MODE|HUB_LISTEN_HOST|HOSTINGER|EMAIL_REDIRECT_TO|WEBSITE_MAKER_|SALES_MAKER_STATUS|SALES_PREVIEW_PUSH_URL|HUB_PUBLIC_URL_FOR_MAKER|ADMIN_SECRET|DELIVERY_BOOT_DATA)/.test(key)) delete shell[key];
  }
  const child = spawn(process.execPath, [join(REPO, 'server.js')], {
    cwd: runDir,
    env: {
      ...shell,
      HUB_SAFE_MODE: '1',
      PERSIST_PRODUCTION_ENV: '0',
      ADMIN_USERNAME: ADMIN,
      ADMIN_PASSWORD,
      WEBSITE_MAKER_STATUS_CALLBACK_TOKEN: CALLBACK_TOKEN,
      PORT: String(port),
      APP_DATA_DIR: dataDir,
      DATA_DIR: '',
      NODE_OPTIONS: `--require="${AUDIT}"`,
      EGRESS_AUDIT_FILE: join(dataDir, `egress-${port}.jsonl`),
      EGRESS_AUDIT_ALLOW: ALLOWLIST,
      EGRESS_AUDIT_ENFORCE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 160 && !up; i += 1) {
    up = await fetch(`${base}/api/health`).then((res) => res.ok, () => false);
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  let token = '';
  for (let i = 0; i < 20 && up && !token; i += 1) {
    const res = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: ADMIN, password: ADMIN_PASSWORD }) }).catch(() => null);
    token = res ? (await res.json().catch(() => ({}))).token || '' : '';
    if (!token) await new Promise((r) => setTimeout(r, 500));
  }
  return {
    base,
    up,
    token,
    log: () => log,
    call(method, path, body, headers = {}) {
      return fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    },
    async stop() {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 700));
      if (child.exitCode === null) child.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 300));
      rmSync(runDir, { recursive: true, force: true });
    },
  };
}

const readJson = (dataDir, name) => (existsSync(join(dataDir, name)) ? JSON.parse(readFileSync(join(dataDir, name), 'utf8')) : []);
const readStores = (dataDir) => Object.fromEntries(STORES.map((name) => [name, existsSync(join(dataDir, name)) ? readFileSync(join(dataDir, name), 'utf8') : '']));

function hasKey(list, key) {
  return (Array.isArray(list) ? list : []).filter((row) => row && Object.hasOwn(row, key)).length;
}

function offerPlanKeys(offers) {
  let count = 0;
  for (const offer of Array.isArray(offers) ? offers : []) {
    if (Object.hasOwn(offer, 'plan') || Object.hasOwn(offer, 'pricing')) count += 1;
    for (const alternative of offer.alternatives || []) if (Object.hasOwn(alternative, 'plan')) count += 1;
  }
  return count;
}

test('batch 2 on the real hub: switches off change nothing; dry run, Maker events and the boot apply when switched on', { timeout: 300_000 }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-delivery-boot-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const kind = seedData(dataDir);
  const before = {
    clients: readJson(dataDir, 'sales-clients.json'),
    sites: readJson(dataDir, 'sites.json'),
    offers: readJson(dataDir, 'sales-offers.json'),
  };

  // ---- 1. switches off
  let hub = await startHub(dataDir);
  t.after(() => hub.stop());
  assert.ok(hub.up && hub.token, `hub did not start:\n${hub.log().slice(-3000)}`);
  const settings = await (await hub.call('GET', '/api/admin/automation-settings')).json();
  assert.equal(settings.settings.development.makerEvents, 'off');
  assert.equal(settings.settings.migrations.deliveryBackfill, 'off');
  for (const path of ['/api/admin/development', '/api/admin/sales', '/api/admin/offers', '/api/hub/sites']) {
    const res = await hub.call('GET', path);
    assert.equal(res.status, 200, path);
    const body = await res.text();
    assert.doesNotMatch(body, /"sitePlan"|"deliveryStage"/, `${path} shows no plan or stage while nothing stored one`);
  }
  for (const site of before.sites) {
    const res = await fetch(`${hub.base}/api/hub/site-config?site_key=${encodeURIComponent(site.site_key)}`);
    assert.equal(res.status, 200);
    const config = await res.json();
    if (site.features) assert.deepEqual(config.features, { ...config.features, ...site.features }, `site ${site.id}: stored flags served`);
    assert.equal(config.websitePlan, site.websitePlan || 'tier-1-standard');
  }
  const linkedClient = before.clients.find((client) => client?.makerRun?.runId && client.product !== 'ssu');
  if (linkedClient) {
    const res = await hub.call('POST', '/api/admin/sales/maker-status-callback', {
      event: 'run.materials.updated', runId: linkedClient.makerRun.runId, salesClientId: linkedClient.id,
      materials: { logo: { present: true }, uploads: { heroImages: 2 }, pageKinds: [{ route: '/team', kind: 'team' }, { route: 'http://127.0.0.1:3000/x', kind: 'menu' }] },
    }, { 'x-sales-callback-token': CALLBACK_TOKEN });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.client, 'switch off: the old step-status response');
    assert.equal(body.recorded, undefined);
    assert.equal(body.client.makerRun.materials, undefined);
  }
  const afterOff = {
    clients: readJson(dataDir, 'sales-clients.json'),
    sites: readJson(dataDir, 'sites.json'),
    offers: readJson(dataDir, 'sales-offers.json'),
  };
  assert.equal(hasKey(afterOff.clients, 'sitePlan') + hasKey(afterOff.clients, 'delivery'), 0, 'no plan or delivery state written');
  assert.equal(hasKey(afterOff.sites, 'planSource'), hasKey(before.sites, 'planSource'), 'no planSource written');
  assert.equal(offerPlanKeys(afterOff.offers), offerPlanKeys(before.offers), 'no offer plan written');
  assert.equal(existsSync(join(dataDir, 'migrations')), false, 'no backfill ran');
  assert.equal(existsSync(join(dataDir, 'delivery-audit')), false, 'no delivery write happened');

  // ---- 2. dry run through the route
  const storesBeforeDry = readStores(dataDir);
  const dryRes = await hub.call('POST', '/api/admin/system/delivery-backfill', {});
  assert.equal(dryRes.status, 200);
  const dry = await dryRes.json();
  assert.equal(dry.mode, 'dry-run');
  assert.deepEqual(readStores(dataDir), storesBeforeDry, 'the dry run writes only its report');
  assert.ok(existsSync(join(dataDir, 'migrations', dry.file)));
  assert.equal(existsSync(join(dataDir, 'delivery-audit')), false, 'a dry run adds nothing to the audit log');
  const signedWebsite = before.clients.filter((client) => client?.product !== 'ssu' && client?.progression?.contractSigned === true).length;
  assert.equal(dry.counts.signedWebsiteClients, signedWebsite);
  assert.equal(dry.counts.sitePlans.write + dry.counts.sitePlans.needsChoice + dry.counts.sitePlans.noEvidence, signedWebsite, 'every signed website client is planned or listed');
  if (kind === 'synthetic') {
    assert.deepEqual(dry.sitePlans.map((entry) => [entry.clientId, entry.tierId, entry.evidence]).sort(), [['boot-live', 'tier-1-standard', 'hub-site'], ['boot-signed', 'tier-2-seo', 'offer']]);
    assert.deepEqual(dry.stages.map((entry) => [entry.clientId, entry.to]).sort(), [['boot-live', 'maintenance'], ['boot-signed', 'gathering']]);
  }
  t.diagnostic(`dry run (${kind} data): ${JSON.stringify(dry.counts)}`);

  // ---- 3. Maker events switched on
  const put = await hub.call('PUT', '/api/admin/automation-settings', { development: { makerEvents: 'record' }, migrations: { deliveryBackfill: 'apply' } });
  assert.equal(put.status, 200, await put.clone().text());
  if (linkedClient) {
    const res = await hub.call('POST', '/api/admin/sales/maker-status-callback', {
      event: 'run.materials.updated', runId: linkedClient.makerRun.runId, salesClientId: linkedClient.id,
      materials: { logo: { present: true }, uploads: { heroImages: 2 }, pageKinds: [{ route: '/team', kind: 'team' }, { route: 'http://127.0.0.1:3000/x', kind: 'menu' }] },
    }, { 'x-sales-callback-token': CALLBACK_TOKEN });
    const body = await res.json();
    assert.deepEqual(body, { ok: true, event: 'run.materials.updated', recorded: ['materials'] });
    const stored = readJson(dataDir, 'sales-clients.json').find((client) => client.id === linkedClient.id);
    assert.deepEqual(stored.makerRun.materials.pageKinds, [{ route: '/team', kind: 'team' }]);
    assert.doesNotMatch(JSON.stringify(stored.makerRun.materials), /127\.0\.0\.1/);
    const refused = await hub.call('POST', '/api/admin/sales/maker-status-callback', { event: 'run.materials.updated', runId: linkedClient.makerRun.runId, materials: {} }, { 'x-sales-callback-token': 'wrong' });
    assert.equal(refused.status, 401, 'the callback auth still applies');
  }
  await hub.stop();

  // ---- 4. boot with migrations.deliveryBackfill = apply, then once more
  hub = await startHub(dataDir);
  assert.ok(hub.up, `hub did not restart:\n${hub.log().slice(-3000)}`);
  assert.match(hub.log(), /\[delivery\] backfill apply: sitePlans \d+/);
  const applied = readJson(dataDir, 'sales-clients.json');
  assert.equal(applied.filter((client) => client.sitePlan).length, dry.counts.sitePlans.write);
  assert.equal(applied.filter((client) => client.product === 'ssu' && client.sitePlan).length, 0, '0 SSU clients get a plan');
  for (const site of before.sites) {
    const config = await (await fetch(`${hub.base}/api/hub/site-config?site_key=${encodeURIComponent(site.site_key)}`)).json();
    if (site.features) assert.deepEqual(config.features, { ...config.features, ...site.features }, `site ${site.id}: flags unchanged after apply`);
  }
  const reportsAfterApply = readdirSync(join(dataDir, 'migrations')).filter((name) => name.endsWith('-apply.json'));
  assert.equal(reportsAfterApply.length, 1);
  const storesAfterApply = readStores(dataDir);
  await hub.stop();

  hub = await startHub(dataDir);
  assert.ok(hub.up);
  assert.match(hub.log(), /\[delivery\] backfill apply skipped: already applied/);
  assert.deepEqual(readStores(dataDir), storesAfterApply, 'the second boot changes nothing');
  assert.equal(readdirSync(join(dataDir, 'migrations')).filter((name) => name.endsWith('-apply.json')).length, 1);
  await hub.stop();

  // A client signs between two boots (the switch still says apply): the boot plans nothing for it.
  const clientsNow = readJson(dataDir, 'sales-clients.json');
  const newcomer = clientsNow.find((client) => client && client.product !== 'ssu' && client.progression?.contractSigned !== true && !client.sitePlan);
  if (newcomer) {
    newcomer.progression = { ...(newcomer.progression || {}), contractSigned: true };
    writeFileSync(join(dataDir, 'sales-clients.json'), JSON.stringify(clientsNow, null, 2));
  }
  hub = await startHub(dataDir);
  assert.ok(hub.up);
  assert.match(hub.log(), /\[delivery\] backfill apply skipped: already applied/);
  if (newcomer) {
    const stored = readJson(dataDir, 'sales-clients.json').find((client) => client.id === newcomer.id);
    assert.equal(stored.sitePlan, undefined, 'no plan for a client that signed after the apply');
    assert.equal(stored.delivery, undefined, 'no stage or email stamp either');
  }
  assert.equal(readdirSync(join(dataDir, 'migrations')).filter((name) => name.endsWith('-apply.json')).length, 1);

  // ---- 5. create-maker-run: the request body carries the plan in force (contract site-plan/1)
  const makerBodies = [];
  const fakeMaker = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url === '/api/runs/v2') {
        const body = JSON.parse(raw || '{}');
        makerBodies.push(body);
        res.end(JSON.stringify({ runId: body.existingRunId || `fake-run-${makerBodies.length}` }));
        return;
      }
      res.end('{}');
    });
  });
  await new Promise((resolve) => fakeMaker.listen(0, '127.0.0.1', resolve));
  t.after(() => fakeMaker.close());
  const makerBase = `http://127.0.0.1:${fakeMaker.address().port}`;
  const withPlan = readJson(dataDir, 'sales-clients.json').find((client) => client.sitePlan && client.product !== 'ssu');
  const withoutPlan = readJson(dataDir, 'sales-clients.json').find((client) => !client.sitePlan && client.product !== 'ssu');
  assert.ok(withPlan, 'the apply stored at least one plan');
  const created = await hub.call('POST', `/api/admin/sales/${encodeURIComponent(withPlan.id)}/create-maker-run`, { websiteMakerBaseUrl: makerBase });
  assert.equal(created.status, 200, await created.clone().text());
  assert.equal(makerBodies.length, 1);
  assert.equal(makerBodies[0].salesClientId, withPlan.id);
  assert.equal(makerBodies[0].sitePlan?.schema, 'site-plan/1');
  assert.equal(makerBodies[0].sitePlan.tierId, withPlan.sitePlan.tierId);
  assert.deepEqual(makerBodies[0].sitePlan.services, withPlan.sitePlan.services);
  assert.match(makerBodies[0].sitePlan.planHash, /^[a-f0-9]{16}$/);
  if (withoutPlan) {
    const plain = await hub.call('POST', `/api/admin/sales/${encodeURIComponent(withoutPlan.id)}/create-maker-run`, { websiteMakerBaseUrl: makerBase });
    assert.equal(plain.status, 200, await plain.clone().text());
    assert.equal(makerBodies.length, 2);
    assert.equal(Object.hasOwn(makerBodies[1], 'sitePlan'), false, 'no plan, no sitePlan key');
  }
  const egress = readdirSync(dataDir).filter((name) => name.startsWith('egress-'))
    .flatMap((name) => readFileSync(join(dataDir, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)))
    .filter((row) => row.blocked === true || row.listed === false);
  assert.deepEqual(egress, [], 'nothing tried to leave the machine');
});
