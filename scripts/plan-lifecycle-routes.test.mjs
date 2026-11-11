// The plan change and un-signing routes (lib/routes/plan-lifecycle-routes.js) on a booted safe-mode hub with
// invented clients (scripts/fixtures/plan-lifecycle-seed.mjs): 401 without credentials, 404 disabled with
// the switches off (and the Kontrakt tick exactly as today), and the changes for pilots in auto.
//
// node --test scripts/plan-lifecycle-routes.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const { bootHub } = await import('./safe-mode/hub-boot.mjs');

const RELEASED = { passedAt: '2026-10-31T10:00:00.000Z', suite: 'plan-lifecycle-routes-test', evidence: '', by: 'test' };
const AUTO_SETTINGS = {
  pilotClientIds: ['pl-change', 'pl-conflict', 'pl-unsign', 'pl-tick'],
  lifecycle: {
    paymentGraceDays: 14,
    cancellationGraceDays: 30,
    planChange: { enabled: true, mode: 'auto', paused: null },
    cancellation: { enabled: true, mode: 'auto', paused: null },
  },
  releases: { 'lifecycle.planChange': RELEASED, 'lifecycle.cancellation': RELEASED },
};

function seed(dir, settings = null) {
  const cwd = mkdtempSync(join(tmpdir(), 'plan-lifecycle-seed-cwd-'));
  const env = { ...process.env, APP_DATA_DIR: dir, DATA_DIR: '' };
  for (const key of Object.keys(env)) if (/^(HUB_SAFE_MODE|ADMIN_)/.test(key)) delete env[key];
  const args = [join(HERE, 'fixtures', 'plan-lifecycle-seed.mjs'), dir, ...(settings ? [JSON.stringify(settings)] : [])];
  const out = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 60_000 });
  rmSync(cwd, { recursive: true, force: true });
  if (out.status !== 0) throw new Error(`seed failed: ${out.stderr || out.stdout}`);
  return JSON.parse(out.stdout.trim().split('\n').pop());
}

async function call(hub, method, path, { token = '', body } = {}) {
  const res = await fetch(`${hub.base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body: json };
}

const readClients = (hub) => JSON.parse(readFileSync(join(hub.dataDir, 'sales-clients.json'), 'utf8'));
const readSites = (hub) => JSON.parse(readFileSync(join(hub.dataDir, 'sites.json'), 'utf8'));
const clientIn = (hub, id) => readClients(hub).find((row) => row.id === id);
const siteIn = (hub, id) => readSites(hub).find((row) => row.id === id);

const STAFF_ROUTES = [
  ['GET', '/api/admin/sales/pl-change/plan-lifecycle'],
  ['PATCH', '/api/admin/sales/pl-change/site-plan', { tierId: 'tier-3-ecommerce' }],
  ['POST', '/api/admin/sales/pl-conflict/site-plan/conflicts/0/accept'],
  ['POST', '/api/admin/sales/pl-conflict/site-plan/conflicts/0/dismiss'],
  ['POST', '/api/admin/sales/pl-unsign/unsign', { reason: 'test' }],
];

test('switches off: 401 without credentials, 404 disabled with them, and the Kontrakt tick unchecks exactly as today', async () => {
  let seeded;
  const hub = await bootHub({}, { seed: (dir) => { seeded = seed(dir); } });
  try {
    assert.equal(hub.health?.safeMode, true, hub.log().slice(-2000));
    const token = await hub.adminToken(seeded.admin.username, seeded.admin.password);
    assert.ok(token);
    const sitesBefore = JSON.stringify(readSites(hub));
    for (const [method, path, body] of STAFF_ROUTES) {
      assert.equal((await call(hub, method, path, { body })).status, 401, `${method} ${path} without credentials`);
      const off = await call(hub, method, path, { token, body });
      assert.equal(off.status, 404, `${method} ${path}`);
      assert.equal(off.body.code, 'disabled');
    }
    // The Kontrakt tick taken off: today's route answers; no plan, site or delivery change of this feature.
    const before = clientIn(hub, 'pl-off-tick');
    const unchecked = await call(hub, 'PATCH', '/api/admin/sales/pl-off-tick/progression', { token, body: { key: 'contractSigned', value: false } });
    assert.equal(unchecked.status, 200);
    assert.deepEqual(Object.keys(unchecked.body).sort(), ['client', 'warnings']);
    const after = clientIn(hub, 'pl-off-tick');
    assert.equal(after.progression.contractSigned, false);
    assert.deepEqual(after.sitePlan, before.sitePlan, 'the plan is untouched');
    assert.equal(after.delivery?.events?.unsignedAt || '', '');
    assert.equal(JSON.stringify(readSites(hub)), sitesBefore, 'no site changed');
  } finally {
    await hub.stop();
  }
});

test('switches in auto for pilots: change the plan, accept a conflict, un-sign, and the Kontrakt tick un-signs', async () => {
  let seeded;
  const hub = await bootHub({}, { seed: (dir) => { seeded = seed(dir, AUTO_SETTINGS); } });
  try {
    assert.equal(hub.health?.safeMode, true, hub.log().slice(-2000));
    const token = await hub.adminToken(seeded.admin.username, seeded.admin.password);
    assert.ok(token);
    for (const [method, path, body] of STAFF_ROUTES) {
      assert.equal((await call(hub, method, path, { body })).status, 401, `${method} ${path} without credentials`);
    }
    const view = await call(hub, 'GET', '/api/admin/sales/pl-change/plan-lifecycle', { token });
    assert.equal(view.status, 200, JSON.stringify(view.body));
    assert.deepEqual([view.body.planChange, view.body.cancellation, view.body.canChangePlan, view.body.canUnsign], ['auto', 'auto', true, true]);
    assert.ok(view.body.tiers.some((tier) => tier.id === 'tier-3-ecommerce'));

    const unknown = await call(hub, 'PATCH', '/api/admin/sales/pl-change/site-plan', { token, body: { tierId: 'tier-9' } });
    assert.equal(unknown.status, 400);
    const changed = await call(hub, 'PATCH', '/api/admin/sales/pl-change/site-plan', { token, body: { tierId: 'tier-3-ecommerce', reason: 'kunden vil ha nettbutikk' } });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.plan.tierId, 'tier-3-ecommerce');
    assert.equal(clientIn(hub, 'pl-change').sitePlan.source, 'superadmin');
    assert.equal(siteIn(hub, 'site-pl-change').websitePlan, 'tier-3-ecommerce');

    const accepted = await call(hub, 'POST', '/api/admin/sales/pl-conflict/site-plan/conflicts/0/accept', { token });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    const conflictClient = clientIn(hub, 'pl-conflict');
    assert.equal(conflictClient.sitePlan.tierId, 'tier-1-standard');
    assert.equal(conflictClient.sitePlan.conflicts[0].status, 'accepted');
    assert.ok(conflictClient.delivery.tasks.some((task) => task.kind === 'plan_downgrade'));
    assert.equal((await call(hub, 'POST', '/api/admin/sales/pl-conflict/site-plan/conflicts/0/accept', { token })).status, 404, 'no open conflict left');

    const unsigned = await call(hub, 'POST', '/api/admin/sales/pl-unsign/unsign', { token, body: { reason: 'kunden angret' } });
    assert.equal(unsigned.status, 200, JSON.stringify(unsigned.body));
    assert.equal(clientIn(hub, 'pl-unsign').sitePlan.status, 'void');
    assert.equal(siteIn(hub, 'site-pl-unsign').deliveryPhase, 'archived');

    const tick = await call(hub, 'PATCH', '/api/admin/sales/pl-tick/progression', { token, body: { key: 'contractSigned', value: false } });
    assert.equal(tick.status, 200, JSON.stringify(tick.body));
    assert.deepEqual(Object.keys(tick.body).sort(), ['client', 'warnings']);
    const tickClient = clientIn(hub, 'pl-tick');
    assert.equal(tickClient.progression.contractSigned, false);
    assert.equal(tickClient.sitePlan.status, 'void');
    assert.ok(tickClient.delivery.events.unsignedAt);
    // Any other progression key still goes to today's route.
    const other = await call(hub, 'PATCH', '/api/admin/sales/pl-change/progression', { token, body: { key: 'meetingHeld', value: true } });
    assert.equal(other.status, 200);
    // A client outside the pilot list stays in shadow: the plan route refuses, the tick unchecks as today.
    const shadowView = await call(hub, 'GET', '/api/admin/sales/pl-off-tick/plan-lifecycle', { token });
    assert.deepEqual([shadowView.body.planChange, shadowView.body.canChangePlan], ['shadow', false]);
    assert.equal((await call(hub, 'PATCH', '/api/admin/sales/pl-off-tick/site-plan', { token, body: { tierId: 'tier-1-standard' } })).body.code, 'not-auto');
    const shadowTick = await call(hub, 'PATCH', '/api/admin/sales/pl-off-tick/progression', { token, body: { key: 'contractSigned', value: false } });
    assert.equal(shadowTick.status, 200);
    const shadowClient = clientIn(hub, 'pl-off-tick');
    assert.equal(shadowClient.progression.contractSigned, false);
    assert.equal(shadowClient.sitePlan.status, 'active', 'shadow voids nothing');
  } finally {
    await hub.stop();
  }
});
