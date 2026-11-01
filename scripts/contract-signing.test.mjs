// Contract signing (lib/contract-signing.js) end to end: a safe-mode hub booted on invented clients
// (scripts/fixtures/signing-seed.mjs) runs every signing path over HTTP (scripts/fixtures/signing-flows.mjs)
// with the switch in auto (clients listed as pilots), in shadow and off. Plus two processes signing one
// client, the offer-scoped portal tier, the settings rules and the entitlement reader.
//
// node --test scripts/contract-signing.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = mkdtempSync(join(tmpdir(), 'asoldi-signing-modules-'));
process.env.APP_DATA_DIR = MODULE_DIR;

const HERE = dirname(fileURLToPath(import.meta.url));
const { bootHub } = await import('./safe-mode/hub-boot.mjs');
const flows = await import('./fixtures/signing-flows.mjs');
const { buildPreWorkshopEmail } = await import('../lib/sales-email.js');

const SEED_DIR = mkdtempSync(join(tmpdir(), 'asoldi-signing-seed-'));
const seed = flows.seedSigningData(SEED_DIR);
const C = seed.clients;
const PILOTS = Object.values(C).filter((id) => id !== C.nonPilot);
const WEBSITE_PATHS = {
  [C.progress]: 'progression',
  [C.gotClient]: 'got-client',
  [C.preview]: 'preview-accept',
  [C.portal]: 'portal-accept',
  [C.stripe]: 'stripe-checkout',
  [C.inbox]: 'inbox-contract',
};
test.after(() => {
  rmSync(SEED_DIR, { recursive: true, force: true });
  rmSync(MODULE_DIR, { recursive: true, force: true });
});

function settingsFor(mode) {
  if (mode === 'off') return null;
  return {
    pilotClientIds: PILOTS,
    signing: { enabled: true, mode, paused: null },
    releases: { signing: { passedAt: '2026-10-31T10:00:00.000Z', suite: 'signing-test', evidence: '', by: 'test' } },
  };
}

async function runMode(mode) {
  const hub = await bootHub(flows.BOOT_ENV, {
    seed: (dir) => {
      cpSync(SEED_DIR, dir, { recursive: true });
      const settings = settingsFor(mode);
      if (settings) writeFileSync(join(dir, 'automation-settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
    },
  });
  try {
    assert.equal(hub.health?.safeMode, true, hub.log().slice(-3000));
    const token = await hub.adminToken(seed.admin.username, seed.admin.password);
    assert.ok(token, 'the seeded admin signs in');
    const steps = await flows.runSigningFlows(hub, seed, { token });
    // The e-mail path signs without waiting; give it time to finish.
    await waitFor(() => clientIn(hub.dataDir, C.inbox)?.progression?.contractSigned === true, 15_000);
    const outbox = await flows.settledOutbox(hub.dataDir);
    const planRoute = await fetch(`${hub.base}/api/admin/sales/${C.progress}/site-plan`, { headers: { authorization: `Bearer ${token}` } });
    const configs = await flows.siteConfigs(hub);
    const egress = hub.egressRows().filter((row) => !row.event && !row.listed);
    return {
      mode,
      steps,
      outbox,
      configs,
      egress,
      planRoute: { status: planRoute.status, body: await planRoute.json().catch(() => ({})) },
      clients: flows.readJsonFile(hub.dataDir, 'sales-clients.json', []),
      sites: flows.readJsonFile(hub.dataDir, 'sites.json', []),
      files: listFiles(hub.dataDir),
      audit: readAudit(hub.dataDir),
      log: hub.log(),
    };
  } finally {
    await hub.stop();
  }
}

function clientIn(dir, id) {
  try {
    return JSON.parse(readFileSync(join(dir, 'sales-clients.json'), 'utf8')).find((entry) => entry.id === id) || null;
  } catch {
    return null;
  }
}

async function waitFor(check, maxMs) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(dir, rel));
    else out.push(rel);
  }
  return out;
}

function readAudit(dir) {
  const folder = join(dir, 'delivery-audit');
  if (!existsSync(folder)) return [];
  return readdirSync(folder).flatMap((name) => readFileSync(join(folder, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));
}

const preWorkshopSubject = (name) => buildPreWorkshopEmail({ businessName: name }, {}, { hasTime: false }).subject;

function view(run, id) {
  const client = run.clients.find((entry) => entry.id === id);
  const sites = run.sites.filter((site) => site.planSource?.salesClientId === id || site.id === client?.hubSite?.id);
  const mails = run.outbox.filter((row) => (row.to || []).some((to) => String(to).toLowerCase() === `${id}@example.com`));
  return {
    client,
    sites,
    mails,
    preWorkshopMails: mails.filter((row) => row.subject === preWorkshopSubject(client?.businessName)),
    informasjon: JSON.stringify(client?.workshop || {}).includes('informasjon-ring'),
  };
}

let auto;
let shadow;
let off;

test('auto: every website path ends in the same signed state with one plan, one site and one pre-workshop mail', { timeout: 240_000 }, async () => {
  auto = await runMode('auto');
  assert.deepEqual(auto.egress, [], 'no unlisted egress');
  for (const [id, source] of Object.entries(WEBSITE_PATHS)) {
    const v = view(auto, id);
    assert.ok(v.client, id);
    assert.equal(v.client.progression.contractSigned, true, `${source}: contractSigned`);
    assert.ok(v.client.contractSignedAt, `${source}: contractSignedAt`);
    assert.equal(v.client.sitePlan?.status, 'active', `${source}: sitePlan`);
    assert.equal(v.client.sitePlan.tierId, 'tier-3-ecommerce', `${source}: tier from the offer`);
    assert.equal(v.client.sitePlan.source, source, `${source}: plan source`);
    assert.equal(v.sites.length, 1, `${source}: exactly one hub site`);
    assert.equal(v.sites[0].planSource?.kind, 'offer', `${source}: planSource kind`);
    assert.equal(v.client.hubSite?.id, v.sites[0].id, `${source}: the site is linked`);
    assert.ok(['signed', 'gathering'].includes(v.client.delivery?.stage), `${source}: stage ${v.client.delivery?.stage}`);
    assert.equal(v.preWorkshopMails.length, 1, `${source}: one pre-workshop mail (${v.mails.length} mails)`);
    assert.equal(v.informasjon, true, `${source}: the Informasjon action`);
  }
  const signingRows = auto.audit.filter((row) => row.kind === 'signing');
  for (const id of Object.keys(WEBSITE_PATHS)) assert.ok(signingRows.some((row) => row.clientId === id), `audit for ${id}`);
  assert.equal(auto.planRoute.status, 200);
  assert.equal(auto.planRoute.body.mode, 'auto');
  assert.equal(auto.planRoute.body.plan.tierId, 'tier-3-ecommerce');
});

test('auto: a second call sends nothing and adds no site', () => {
  assert.equal(auto.steps['progression-again'].status, 200);
  const v = view(auto, C.progress);
  assert.equal(v.preWorkshopMails.length, 1);
  assert.equal(v.sites.length, 1);
  assert.equal(v.client.sitePlan.history.length, 1, 'one plan history entry');
});

test('auto: SSU gets only the signing stamp: no site, no plan, no mail', () => {
  assert.equal(auto.steps['progression-ssu'].status, 200);
  const v = view(auto, C.ssu);
  assert.equal(v.client.progression.contractSigned, true);
  assert.equal(v.client.sitePlan, undefined);
  assert.equal(v.sites.length, 0);
  assert.equal(v.mails.length, 0);
});

test('auto: a dual offer without a chosen alternative changes nothing', () => {
  assert.equal(auto.steps['progression-dual'].status, 409);
  assert.equal(auto.steps['progression-dual'].body.needsChoice, true);
  const seeded = JSON.parse(readFileSync(join(SEED_DIR, 'sales-clients.json'), 'utf8')).find((entry) => entry.id === C.dual);
  const v = view(auto, C.dual);
  assert.equal(v.client.updatedAt, seeded.updatedAt, 'the stored client was not written');
  assert.notEqual(v.client.progression.contractSigned, true);
  assert.equal(v.client.contractSignedAt || '', '');
  assert.equal(v.client.sitePlan, undefined);
  assert.equal(v.client.delivery, undefined);
  assert.equal(v.sites.length, 0);
  assert.equal(v.mails.length, 0);
});

test('auto: a Stripe checkout without offer metadata does not sign and leaves "Mangler tilbudsaksept"', () => {
  assert.equal(auto.steps['stripe-no-offer'].status, 200);
  const v = view(auto, C.stripeNone);
  assert.notEqual(v.client.progression.contractSigned, true);
  assert.equal(v.client.sitePlan, undefined);
  assert.equal(v.sites.length, 0);
  assert.equal(v.mails.length, 0);
  assert.ok((v.client.nextActions || []).some((action) => action.name === 'Mangler tilbudsaksept' && !action.doneAt));
});

test('auto: a client that is not a pilot runs as shadow (today\'s path plus the shadow record)', () => {
  const v = view(auto, C.nonPilot);
  assert.equal(v.client.progression.contractSigned, true, 'signed as before');
  assert.equal(v.client.sitePlan, undefined, 'no plan written');
  assert.equal(v.sites.length, 0, 'no site written');
  assert.equal(v.preWorkshopMails.length, 1, 'the mail as before');
  assert.equal(v.client.delivery?.sitePlanShadow?.tierId, 'tier-3-ecommerce');
  assert.ok(auto.audit.some((row) => row.kind === 'signing-shadow' && row.clientId === C.nonPilot));
});

test('auto: a tier-1 client who accepts a tier-2 offer gets tier 2 (plan, site and portal)', () => {
  assert.equal(auto.steps['connect-upgrade'].status, 200);
  assert.equal(auto.steps['connect-upgrade'].body.tier.id, 'tier-2-seo', 'connect-portal takes the offer\'s own tier');
  assert.equal(auto.steps['portal-accept-upgrade'].status, 200);
  const v = view(auto, C.upgrade);
  assert.equal(v.client.sitePlan.tierId, 'tier-2-seo');
  assert.equal(v.client.sitePlan.offerId, 'so-upgrade-new');
  assert.equal(v.client.sitePlan.history.at(-1).from.tierId, 'tier-1-standard');
  assert.equal(v.sites.length, 1);
  assert.equal(v.sites[0].websitePlan, 'tier-2-seo');
  assert.equal(v.sites[0].planSource.tierId, 'tier-2-seo');
  assert.equal(v.preWorkshopMails.length, 0, 'an upgrade sends no pre-workshop mail');
});

test('auto: the go-live callback v2 records the status and keeps the one site', () => {
  assert.equal(auto.steps.golive.status, 200);
  assert.equal(auto.steps.golive.body.goLive.status, 'pushed');
  assert.equal(auto.steps.golive.body.goLive.target, 'production');
  const v = view(auto, C.progress);
  assert.equal(v.sites.length, 1, 'no second site for the Maker key');
  assert.equal(v.client.makerRun.goLive.siteKeyMismatch, true, 'the other key is flagged');
  assert.ok(v.client.delivery.tasks.some((task) => task.kind === 'site_key_mismatch' && task.status === 'open'));
  assert.notEqual(v.client.progression.live, true, 'a push is not live');
});

test('auto: site-config of every signed site carries the plan flags', () => {
  for (const id of Object.keys(WEBSITE_PATHS)) {
    const site = view(auto, id).sites[0];
    const config = auto.configs[site.id];
    assert.equal(config.status, 200, id);
    assert.equal(config.body.features.ecommerce, true, id);
    assert.equal(config.body.websitePlan, 'tier-3-ecommerce', id);
  }
});

test('off: every path runs as before: no plan, no planSource, no shadow record, no lease, the plan route is disabled', { timeout: 240_000 }, async () => {
  off = await runMode('off');
  assert.deepEqual(off.egress, []);
  for (const client of off.clients) {
    if (client.id === C.upgrade) continue;
    assert.equal(client.sitePlan, undefined, `${client.id}: no plan`);
    assert.equal(client.delivery, undefined, `${client.id}: no delivery record`);
    assert.equal(client.makerRun?.goLive, undefined, `${client.id}: no goLive`);
  }
  const upgradeSeed = JSON.parse(readFileSync(join(SEED_DIR, 'sales-clients.json'), 'utf8')).find((entry) => entry.id === C.upgrade);
  assert.deepEqual(off.clients.find((entry) => entry.id === C.upgrade).sitePlan.tierId, upgradeSeed.sitePlan.tierId, 'the stored plan is untouched');
  assert.equal(off.steps['connect-upgrade'].body.tier.id, 'tier-1-standard', 'control: the old chooser picks the stale tier');
  assert.equal(off.sites.filter((site) => site.planSource).length, 1, 'only the seeded planSource');
  assert.equal(off.files.some((file) => file.startsWith('delivery-audit/')), false, 'no delivery audit');
  assert.equal(off.files.some((file) => /^email-locks\/sign_/.test(file)), false, 'no signing lease');
  assert.equal(off.planRoute.status, 404);
  assert.equal(off.planRoute.body.code, 'disabled');
  assert.equal(off.steps['progression-dual'].status, 200, 'control: today the Kontrakt tick signs a dual offer');
  assert.equal(off.steps.golive.body.goLive, undefined, 'the callback answers as before');
  assert.equal(Object.hasOwn(off.steps.golive.body, 'goLive'), false);
});

test('shadow: sitePlan, sites and planSource are what the switch-off run wrote; only the shadow record is added', { timeout: 240_000 }, async () => {
  shadow = await runMode('shadow');
  assert.deepEqual(shadow.egress, []);
  const strip = (site) => {
    const { id, site_key: key, createdAt, ...rest } = site;
    return JSON.stringify({ ...rest, cms: { ...rest.cms, lastSeenAt: '' } });
  };
  assert.deepEqual(shadow.sites.map(strip).sort(), off.sites.map(strip).sort(), 'the same sites');
  for (const client of shadow.clients) {
    const other = off.clients.find((entry) => entry.id === client.id);
    assert.deepEqual(client.sitePlan, other.sitePlan, `${client.id}: sitePlan`);
    assert.equal(client.progression?.contractSigned, other.progression?.contractSigned, `${client.id}: signed as before`);
    assert.equal(client.makerRun?.goLive?.target, client.id === C.progress ? 'production' : undefined, `${client.id}: goLive`);
  }
  for (const id of Object.keys(WEBSITE_PATHS)) {
    assert.equal(view(shadow, id).preWorkshopMails.length, view(off, id).preWorkshopMails.length, `${id}: the same mails`);
  }
  assert.ok(shadow.audit.filter((row) => row.kind === 'signing-shadow').length >= 5, 'shadow records');
  assert.equal(shadow.audit.some((row) => row.kind === 'signing'), false, 'nothing signed by the signer');
  assert.equal(shadow.clients.find((entry) => entry.id === C.progress).delivery.sitePlanShadow.tierId, 'tier-3-ecommerce');
  assert.equal(shadow.planRoute.status, 200);
  assert.equal(shadow.planRoute.body.mode, 'shadow');
  assert.equal(shadow.planRoute.body.canConfirm, false);
});

test('two processes signing one client at once yield one site, one plan entry and one mail', { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-signing-race-'));
  try {
    cpSync(SEED_DIR, dir, { recursive: true });
    writeFileSync(join(dir, 'automation-settings.json'), JSON.stringify(settingsFor('auto')));
    const startAt = Date.now() + 1500;
    const run = () => new Promise((resolve) => {
      const env = { ...process.env, APP_DATA_DIR: dir, DATA_DIR: '' };
      const child = spawn(process.execPath, [join(HERE, 'fixtures', 'contract-signing-race-child.mjs'), C.progress, String(startAt)], { cwd: dir, env });
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.stderr.on('data', (chunk) => { err += chunk; });
      child.on('close', (code) => resolve({ code, out, err }));
    });
    const results = await Promise.all([run(), run()]);
    const parsed = results.map((result) => {
      assert.equal(result.code, 0, result.err);
      return JSON.parse(result.out.trim().split('\n').pop());
    });
    assert.deepEqual(parsed.map((row) => row.ok), [true, true]);
    assert.equal(parsed.filter((row) => row.alreadySigned).length, 1, 'the second process found the client signed');
    assert.equal(parsed.filter((row) => row.mailed).length, 1, 'one mail');
    const sites = JSON.parse(readFileSync(join(dir, 'sites.json'), 'utf8')).filter((site) => site.planSource?.salesClientId === C.progress);
    assert.equal(sites.length, 1, 'one site');
    const client = JSON.parse(readFileSync(join(dir, 'sales-clients.json'), 'utf8')).find((entry) => entry.id === C.progress);
    assert.equal(client.sitePlan.history.length, 1);
    const rows = readFileSync(join(dir, 'outbox', 'index.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(rows.filter((row) => (row.to || []).includes(`${C.progress}@example.com`)).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
