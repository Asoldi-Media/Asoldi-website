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

async function runMode(mode, { after = null } = {}) {
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
    await waitFor(() => clientIn(hub.dataDir, C.inboxFresh)?.progression?.contractSigned === true, 15_000);
    await waitFor(() => clientIn(hub.dataDir, C.inboxDual)?.progression?.contractSigned === true
      || readAudit(hub.dataDir).some((row) => row.kind === 'signing-needs-choice' && row.clientId === C.inboxDual), 15_000);
    const outbox = await flows.settledOutbox(hub.dataDir);
    const planRoute = await fetch(`${hub.base}/api/admin/sales/${C.progress}/site-plan`, { headers: { authorization: `Bearer ${token}` } });
    const configs = await flows.siteConfigs(hub);
    const makerKey = await fetch(`${hub.base}/api/hub/site-config?site_key=maker-key-progress`);
    const egress = hub.egressRows().filter((row) => !row.event && !row.listed);
    const snapshot = {
      clients: flows.readJsonFile(hub.dataDir, 'sales-clients.json', []),
      sites: flows.readJsonFile(hub.dataDir, 'sites.json', []),
      files: listFiles(hub.dataDir),
      audit: readAudit(hub.dataDir),
    };
    // Steps after the snapshot (the tests above read the state the flows left).
    const extra = after ? await after(hub, token) : null;
    return {
      mode,
      extra,
      steps,
      outbox,
      configs,
      egress,
      planRoute: { status: planRoute.status, body: await planRoute.json().catch(() => ({})) },
      makerKeyConfig: { status: makerKey.status, body: await makerKey.json().catch(() => ({})) },
      ...snapshot,
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

/**
 * auto, after the flows: the sales card's choice for the two dual-offer clients, then the rep picks
 * alternative 2 for the one whose contract came by e-mail.
 */
async function chooseAlternative(hub, token) {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const view = async (id) => {
    const res = await fetch(`${hub.base}/api/admin/sales/${id}/site-plan`, { headers });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const out = { dualView: await view(C.dual), inboxDualView: await view(C.inboxDual), gotDupView: await view(C.gotDup), progressView: await view(C.progress) };
  const mailsBefore = (await flows.settledOutbox(hub.dataDir)).length;
  const res = await fetch(`${hub.base}/api/admin/sales/${C.inboxDual}/progression`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ key: 'contractSigned', value: true, fastTrack: true, chosenOfferIndex: 1 }),
  });
  out.choose = { status: res.status, body: await res.json().catch(() => ({})) };
  out.newMails = (await flows.settledOutbox(hub.dataDir)).slice(mailsBefore);
  out.inboxDualAfter = await view(C.inboxDual);
  out.clients = flows.readJsonFile(hub.dataDir, 'sales-clients.json', []);
  out.sites = flows.readJsonFile(hub.dataDir, 'sites.json', []);
  return out;
}

test('auto: every website path ends in the same signed state with one plan, one site and one pre-workshop mail', { timeout: 240_000 }, async () => {
  auto = await runMode('auto', { after: chooseAlternative });
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
    // The got-client site gets a Superadmin plan edit at the end of the flows (checked below).
    assert.equal(v.sites[0].planSource?.kind, id === C.gotClient ? 'admin' : 'offer', `${source}: planSource kind`);
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

test('auto: the go-live callback v2 records the status, keeps the one site and gives it the Maker\'s key', () => {
  assert.equal(auto.steps.golive.status, 200);
  assert.equal(auto.steps.golive.body.goLive.status, 'pushed');
  assert.equal(auto.steps.golive.body.goLive.target, 'production');
  const v = view(auto, C.progress);
  assert.equal(v.sites.length, 1, 'no second site for the Maker key');
  assert.equal(v.sites[0].site_key, 'maker-key-progress', 'the site made at signing, which no CMS reached, takes the Maker key');
  assert.equal(v.client.hubSite.siteKey, 'maker-key-progress', 'the client link follows');
  assert.equal(v.sites[0].domain, 'progress.example.com', 'the published domain fills in the site');
  assert.notEqual(v.client.makerRun.goLive.siteKeyMismatch, true, 'nothing to flag');
  assert.equal((v.client.delivery.tasks || []).some((task) => task.kind === 'site_key_mismatch'), false);
  assert.ok(auto.audit.some((row) => row.kind === 'site-key-adopted' && row.clientId === C.progress));
  // The published CMS asks with the Maker key and gets the plan.
  assert.equal(auto.makerKeyConfig.status, 200);
  assert.equal(auto.makerKeyConfig.body.id, v.sites[0].id);
  assert.equal(auto.makerKeyConfig.body.websitePlan, 'tier-3-ecommerce');
  assert.equal(auto.makerKeyConfig.body.features.ecommerce, true);
  assert.notEqual(v.client.progression.live, true, 'a push is not live');
});

test('auto: site-config of every signed site carries the plan flags', () => {
  for (const id of Object.keys(WEBSITE_PATHS)) {
    const site = view(auto, id).sites[0];
    const config = auto.configs[site.id];
    assert.equal(config.status, 200, id);
    assert.equal(config.body.features.ecommerce, true, id);
    assert.equal(config.body.websitePlan, id === C.gotClient ? 'tier-2-seo' : 'tier-3-ecommerce', id);
  }
});

test('auto: a Superadmin websitePlan edit makes the site plan an admin choice; off it is a plain edit', () => {
  const edited = auto.steps['site-plan-edit'];
  assert.equal(edited.status, 200);
  assert.equal(edited.body.websitePlan, 'tier-2-seo');
  assert.equal(edited.body.planSource.kind, 'admin');
  assert.equal(edited.body.planSource.tierId, 'tier-2-seo');
  assert.equal(edited.body.planSource.salesClientId, C.gotClient);
  assert.ok(auto.audit.some((row) => row.kind === 'plan-source' && row.clientId === C.gotClient));
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
  assert.equal(off.steps['site-plan-edit'].status, 200);
  assert.equal(off.steps['site-plan-edit'].body.planSource, undefined, 'a plain edit writes no planSource');
  assert.equal(Object.hasOwn(off.steps.golive.body, 'goLive'), false);
  assert.equal(off.makerKeyConfig.status, 200, 'control: the old handler makes a bare site with the Maker key');
  assert.equal(off.makerKeyConfig.body.websitePlan, 'tier-1-standard', 'control: without the plan');
});

test('auto: a contract by e-mail or portal for a client with nothing ticked and no sent offer signs as with the switch off', () => {
  for (const id of [C.inboxFresh, C.portalFresh]) {
    const a = view(auto, id);
    const o = view(off, id);
    assert.equal(o.client.progression.contractSigned, true, `control ${id}: the switch-off path signs`);
    assert.equal(a.client.progression.contractSigned, true, `${id}: signed in auto`);
    assert.ok(a.client.contractSignedAt, `${id}: contractSignedAt`);
    for (const key of ['meetingHeld', 'offerSent', 'contractSigned']) assert.equal(a.client.progression[key], o.client.progression[key], `${id}: ${key}`);
    assert.equal(a.preWorkshopMails.length, 1, `${id}: one pre-workshop mail`);
    assert.equal(a.preWorkshopMails.length, o.preWorkshopMails.length, `${id}: the same mails as off`);
    assert.equal(a.informasjon, true, `${id}: the Informasjon action`);
    assert.equal(a.client.sitePlan?.status, 'active', `${id}: a plan`);
    assert.equal(a.sites.length, 1, `${id}: one site`);
  }
  assert.equal(view(auto, C.portalFresh).client.sitePlan.offerId, 'so-portal-fresh', 'the accepted offer\'s plan');
  assert.equal(auto.log.includes('Marker møtet hatt først'), false, 'no blocked signing in the log');
});

test('auto: got-client for a lead whose domain is another client\'s site signs but links and changes no site; off links it as today', () => {
  const step = auto.steps['got-client-same-domain'];
  assert.equal(step.status, 409);
  assert.equal(step.body.code, 'site-owned-elsewhere');
  const v = view(auto, C.gotDup);
  assert.equal(v.client.progression.contractSigned, true, 'signed');
  assert.equal(v.client.sitePlan?.status, 'active', 'with its plan');
  assert.equal(v.client.hubSite?.id || '', '', 'no site linked');
  assert.equal(v.sites.length, 0, 'no site made or taken');
  assert.ok(v.client.delivery.tasks.some((task) => task.kind === 'site_owner_conflict' && task.siteId === 'site-owned' && task.status === 'open'));
  const owned = auto.sites.find((site) => site.id === 'site-owned');
  assert.equal(owned.deliveryPhase, 'client', 'the other client\'s site keeps its phase');
  assert.equal(owned.websitePlan, 'tier-1-standard');
  assert.equal(owned.planSource, undefined);
  assert.equal(auto.clients.find((entry) => entry.id === C.owner).hubSite.id, 'site-owned');
  assert.equal(off.steps['got-client-same-domain'].status, 200, 'control: the switch-off path answers 200');
  assert.equal(off.clients.find((entry) => entry.id === C.gotDup).hubSite.id, 'site-owned', 'control: and links the other client\'s site');
});

test('auto: a dual offer signed by e-mail changes nothing and leaves an audit line; off signs it as today', () => {
  const a = view(auto, C.inboxDual);
  assert.notEqual(a.client.progression.contractSigned, true);
  assert.equal(a.client.sitePlan, undefined);
  assert.equal(a.client.delivery, undefined);
  assert.equal(a.mails.length, 0);
  assert.ok(auto.audit.some((row) => row.kind === 'signing-needs-choice' && row.clientId === C.inboxDual && row.source === 'inbox-contract'));
  assert.ok((a.client.nextActions || []).some((action) => action.name === 'Velg tilbudsalternativ' && !action.doneAt), 'the rep gets "Velg tilbudsalternativ"');
  assert.equal(view(off, C.inboxDual).client.progression.contractSigned, true, 'control: the switch-off path signs');
  assert.equal((view(off, C.inboxDual).client.nextActions || []).some((action) => action.name === 'Velg tilbudsalternativ'), false, 'control: no such action with the switch off');
  assert.equal(off.audit.length, 0, 'control: no audit line with the switch off');
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

test('a second process reading the sales store waits for the lock before it migrates old rows, and saves each row once', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-sales-migrate-'));
  try {
    const rows = JSON.parse(readFileSync(join(SEED_DIR, 'sales-clients.json'), 'utf8'));
    assert.ok(rows.length > 1);
    for (const row of rows) delete row.salesMigrations;
    const file = join(dir, 'sales-clients.json');
    writeFileSync(file, JSON.stringify(rows, null, 2));
    const child = spawn(process.execPath, [join(HERE, 'fixtures', 'sales-migration-child.mjs')], { cwd: dir, env: { ...process.env, APP_DATA_DIR: dir, DATA_DIR: '' } });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    const closed = new Promise((resolve) => child.on('close', resolve));
    const readyBy = Date.now() + 30_000;
    while (!out.includes('ready') && Date.now() < readyBy) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(out.includes('ready'), `the child loaded its modules: ${err}`);
    const startAt = Date.now() + 800;
    child.stdin.write(`${startAt}\n`);
    while (Date.now() < startAt - 300) await new Promise((resolve) => setTimeout(resolve, 20));
    // This process holds the sales store lock across the moment the child reads: the child must not
    // write while the lock is held.
    const { withFileLock } = await import('../data/atomic-json.js');
    const during = withFileLock(file, () => {
      const sleeper = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(sleeper, 0, 0, 1200);
      return readFileSync(file, 'utf8');
    });
    assert.equal(JSON.parse(during).filter((row) => row.salesMigrations?.meetingHeldOrphansV1).length, 0, 'nothing was migrated while another process held the lock');
    assert.equal(await closed, 0, err);
    const result = JSON.parse(out.trim().split('\n').pop());
    assert.equal(result.count, rows.length);
    const after = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(after.length, rows.length);
    assert.ok(after.every((row) => row.salesMigrations?.meetingHeldOrphansV1), 'every row carries the migration mark afterwards');
    assert.equal(existsSync(`${file}.lock`), false, 'the lock is released');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- another client's site

const seededSite = (id) => JSON.parse(readFileSync(join(SEED_DIR, 'sites.json'), 'utf8')).find((site) => site.id === id);

/** The live client's site after a run: phase, plan, flags and planSource as seeded, site-config too. */
function assertOwnedSiteUnchanged(run, label) {
  const seeded = seededSite('site-owned');
  const owned = run.sites.find((site) => site.id === 'site-owned');
  assert.equal(owned.site_key, seeded.site_key, `${label}: key`);
  assert.equal(owned.deliveryPhase, seeded.deliveryPhase, `${label}: delivery phase`);
  assert.equal(owned.websitePlan, seeded.websitePlan, `${label}: websitePlan`);
  assert.equal(owned.planSource, undefined, `${label}: no planSource`);
  for (const flag of ['ecommerce', 'analytics', 'socialSync', 'emailMarketing']) assert.equal(Boolean(owned.features?.[flag]), Boolean(seeded.features?.[flag]), `${label}: ${flag}`);
  const config = run.configs['site-owned'];
  assert.equal(config.status, 200, label);
  assert.equal(config.body.websitePlan, 'tier-1-standard', `${label}: site-config websitePlan`);
  assert.equal(Boolean(config.body.features?.ecommerce), false, `${label}: site-config ecommerce`);
  assert.equal(run.clients.find((entry) => entry.id === C.owner).hubSite.id, 'site-owned', `${label}: the owner keeps its link`);
}

test('auto: got-client retried twice and a later Kontrakt tick for the same-domain lead leave the other client\'s site alone; off links it as today', () => {
  for (const name of ['got-client-same-domain', 'got-client-same-domain-retry', 'got-client-same-domain-third']) {
    assert.equal(auto.steps[name].status, 409, name);
    assert.equal(auto.steps[name].body.code, 'site-owned-elsewhere', name);
  }
  const tick = auto.steps['progression-same-domain'];
  assert.equal(tick.status, 200);
  assert.ok(tick.body.warnings.includes('plan-apply:site-owned-elsewhere'), 'the signer says why no site was applied');
  const v = view(auto, C.gotDup);
  assert.equal(v.client.hubSite?.id || '', '', 'the lead links no site');
  assert.equal(v.client.hubSite?.siteKey || '', '', 'and holds no key');
  assert.equal(v.client.sitePlan.appliedSiteId, '', 'its plan is applied nowhere');
  assert.equal(v.client.delivery.tasks.filter((task) => task.kind === 'site_owner_conflict' && task.status === 'open').length, 1, 'one task for a person');
  assert.equal(v.preWorkshopMails.length, 1, 'one pre-workshop mail over every call');
  assertOwnedSiteUnchanged(auto, 'auto');
  assert.deepEqual(auto.extra.gotDupView.body.siteConflicts.map((row) => row.siteId), ['site-owned'], 'the sales card shows the conflict');
  assert.deepEqual(auto.extra.progressView.body.siteConflicts, [], 'and nothing for a client without one');
  // Control: the switch-off build links the site on every call and moves it to development.
  for (const name of ['got-client-same-domain', 'got-client-same-domain-retry', 'got-client-same-domain-third']) assert.equal(off.steps[name].status, 200, `control: ${name}`);
  assert.equal(off.clients.find((entry) => entry.id === C.gotDup).hubSite.siteKey, 'key-owned', 'control: the lead holds the other client\'s key');
  assert.equal(off.sites.find((site) => site.id === 'site-owned').deliveryPhase, 'development', 'control: the other client\'s site moves');
});

test('auto: a lead whose link was copied from the live client\'s site is signed, but that site and its site-config stay as they were', () => {
  const tick = auto.steps['progression-copied-link'];
  assert.equal(tick.status, 200);
  assert.ok(tick.body.warnings.includes('plan-apply:site-owned-elsewhere'));
  assert.equal(auto.steps['got-client-copied-link'].status, 409);
  assert.equal(auto.steps['got-client-copied-link'].body.code, 'site-owned-elsewhere');
  const lead = auto.clients.find((entry) => entry.id === C.copiedLink);
  assert.equal(lead.progression.contractSigned, true, 'signed');
  assert.equal(lead.sitePlan.status, 'active', 'with its plan');
  assert.equal(lead.sitePlan.appliedSiteId, '', 'applied nowhere');
  assert.ok(lead.delivery.tasks.some((task) => task.kind === 'site_owner_conflict' && task.siteId === 'site-owned' && task.status === 'open'));
  assert.equal(auto.sites.filter((site) => site.planSource?.salesClientId === C.copiedLink).length, 0, 'no site carries its plan');
  assertOwnedSiteUnchanged(auto, 'auto');
  assert.ok(auto.audit.some((row) => row.kind === 'site-owner-conflict' && row.clientId === C.copiedLink && row.siteId === 'site-owned'));
  // Control: the switch-off build answers got-client with the other client's site.
  assert.equal(off.steps['got-client-copied-link'].status, 200, 'control');
  assert.equal(off.steps['got-client-copied-link'].body.site.id, 'site-owned', 'control: the copied link wins today');
});

test('auto: a dual offer waits for a choice on the sales card; the chosen alternative signs once, with its plan', () => {
  const dual = auto.steps['progression-dual'];
  assert.equal(dual.status, 409);
  assert.deepEqual(dual.body.alternatives.map((row) => [row.index, row.tierId]), [[0, 'tier-1-standard'], [1, 'tier-2-seo']], 'the 409 names both alternatives');
  const x = auto.extra;
  assert.equal(x.dualView.status, 200);
  assert.deepEqual(x.dualView.body.choice.alternatives.map((row) => row.tierId), ['tier-1-standard', 'tier-2-seo']);
  assert.equal(x.dualView.body.choice.contractReceived, false, 'no contract came in yet');
  assert.equal(x.inboxDualView.body.choice.contractReceived, true, 'the contract by e-mail is waiting for the choice');
  assert.equal(x.choose.status, 200, JSON.stringify(x.choose.body).slice(0, 300));
  const client = x.clients.find((entry) => entry.id === C.inboxDual);
  assert.equal(client.progression.contractSigned, true);
  assert.equal(client.sitePlan.tierId, 'tier-2-seo', 'the chosen alternative\'s plan');
  assert.equal(client.sitePlan.alternativeIndex, 1);
  assert.equal(x.sites.filter((site) => site.planSource?.salesClientId === C.inboxDual).length, 1, 'one site');
  const subject = preWorkshopSubject(client.businessName);
  assert.equal(x.newMails.filter((row) => row.subject === subject && (row.to || []).includes(`${C.inboxDual}@example.com`)).length, 1, 'one pre-workshop mail');
  assert.equal((client.nextActions || []).some((action) => action.name === 'Velg tilbudsalternativ' && !action.doneAt), false, 'the choice action is closed');
  assert.equal(x.inboxDualAfter.body.choice, null, 'nothing left to choose');
  // Control: with the switch off the card route is disabled and the e-mail path signed without a choice.
  assert.equal(off.planRoute.status, 404);
  assert.equal(view(off, C.inboxDual).client.sitePlan, undefined);
});
