// Negative control for the delivery loop on the real hub (server.js), 127.0.0.1 only, from an empty
// working folder, with the egress recorder enforcing.
//
// With delivery.loop off (the default) no tick runs: no lease, no loop file and no delivery record
// appears, the Maker job routes answer 404 {code:'disabled'}, and the heartbeat offers nothing.
//
// DARK_CONTROL_BASE_DIR=<checkout of the previous release with its node_modules> also boots that
// build on an identical copy of the data and checks that GET /api/admin/development answers the
// same and leaves the same data behind (timestamps created during the run are masked).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALLOWLIST, AUDIT, REPO, freePort } from './safe-mode/hub-boot.mjs';

const ADMIN = 'dark-control-admin';
const ADMIN_PASSWORD = `dark-control-${Date.now()}-pw`;
const STARTED = Date.now();

function seed(dataDir) {
  const signed = { meetingHeld: true, offerSent: true, contractSigned: true };
  const clients = [
    { id: 'dark-signed', product: 'asoldi', businessName: 'Eksempel Signert AS', status: 'active', progression: signed, contractSignedAt: '2026-10-01T10:00:00.000Z', hubSite: { id: 'site-a', siteKey: 'dark-key-a' }, createdAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-01T10:00:00.000Z' },
    { id: 'dark-done', product: 'asoldi', businessName: 'Eksempel Ferdig AS', status: 'active', progression: signed, development: { nettsideFerdig: true }, hubSite: { id: 'site-b', siteKey: 'dark-key-b' }, createdAt: '2026-08-01T10:00:00.000Z', updatedAt: '2026-08-01T10:00:00.000Z' },
    { id: 'dark-lead', product: 'asoldi', businessName: 'Eksempel Lead AS', status: 'active', progression: { meetingHeld: true }, createdAt: '2026-07-01T10:00:00.000Z', updatedAt: '2026-07-01T10:00:00.000Z' },
  ];
  const sites = [
    { id: 'site-a', site_key: 'dark-key-a', name: 'Site A', domain: 'site-a.example', websitePlan: 'tier-1-standard', deliveryPhase: 'development', createdAt: '2026-09-01T10:00:00.000Z' },
    { id: 'site-b', site_key: 'dark-key-b', name: 'Site B', domain: 'site-b.example', websitePlan: 'tier-1-standard', deliveryPhase: 'development', createdAt: '2026-08-01T10:00:00.000Z' },
  ];
  writeFileSync(join(dataDir, 'sales-clients.json'), JSON.stringify(clients, null, 2));
  writeFileSync(join(dataDir, 'sites.json'), JSON.stringify(sites, null, 2));
}

async function startHub(repo, dataDir) {
  const port = await freePort();
  const runDir = mkdtempSync(join(tmpdir(), 'asoldi-dark-cwd-'));
  const shell = { ...process.env };
  for (const key of Object.keys(shell)) {
    if (/^(HUB_SAFE_MODE|HUB_LISTEN_HOST|HOSTINGER|EMAIL_REDIRECT_TO|WEBSITE_MAKER_|SALES_MAKER_STATUS|SALES_PREVIEW_PUSH_URL|HUB_PUBLIC_URL_FOR_MAKER|ADMIN_SECRET|DARK_CONTROL)/.test(key)) delete shell[key];
  }
  const child = spawn(process.execPath, [join(repo, 'server.js')], {
    cwd: runDir,
    env: {
      ...shell,
      HUB_SAFE_MODE: '1',
      PERSIST_PRODUCTION_ENV: '0',
      ADMIN_USERNAME: ADMIN,
      ADMIN_PASSWORD,
      PORT: String(port),
      APP_DATA_DIR: dataDir,
      DATA_DIR: '',
      NODE_OPTIONS: `--require="${AUDIT}"`,
      EGRESS_AUDIT_FILE: join(runDir, `egress-${port}.jsonl`),
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
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
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

/** JSON text with every timestamp created during this test run replaced by a marker. */
function maskRunTimes(text) {
  return String(text).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/g, (stamp) => (Date.parse(stamp) >= STARTED - 1000 ? '<run-time>' : stamp));
}

function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

async function developmentRound(repo, dataDir) {
  const hub = await startHub(repo, dataDir);
  try {
    assert.ok(hub.up && hub.token, `hub did not start:\n${hub.log().slice(-3000)}`);
    await new Promise((r) => setTimeout(r, 2500)); // the background plan has started by now
    const res = await hub.call('GET', '/api/admin/development');
    assert.equal(res.status, 200);
    const body = await res.text();
    return { hub, body };
  } catch (error) {
    await hub.stop();
    throw error;
  }
}

test('delivery loop off on the real hub: no tick, no loop files, dark routes', { timeout: 300_000 }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-dark-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  seed(dataDir);
  const { hub, body } = await developmentRound(REPO, dataDir);
  t.after(() => hub.stop());
  assert.ok(body.includes('dark-signed'));
  const loopView = await (await hub.call('GET', '/api/admin/system/delivery-loop')).json();
  assert.equal(loopView.enabled, false);
  assert.equal(loopView.mode, 'off');
  assert.equal(loopView.health.ticks, 0, 'no tick ran');
  const tick = await (await hub.call('POST', '/api/admin/system/delivery-loop/tick', {})).json();
  assert.deepEqual([tick.ran, tick.reason], [false, 'disabled'], 'even a forced tick does nothing while off');
  for (const path of ['/api/maker/jobs', '/api/maker/jobs/job_abcdefgh12/claim', '/api/maker/clients/dark-signed/link-run']) {
    const res = await fetch(`${hub.base}${path}`, { method: path.endsWith('jobs') ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: path.endsWith('jobs') ? undefined : '{}' });
    assert.equal(res.status, 404, path);
    assert.equal((await res.json()).code, 'disabled');
  }
  const files = listFiles(dataDir);
  assert.deepEqual(files.filter((name) => /^delivery-hot\/|^delivery-jobs\.json$|^email-locks\/.*delivery-loop|^delivery-audit\//.test(name)), [], 'the loop wrote nothing');
  const safe = await (await hub.call('GET', '/api/admin/system/safe-mode')).json();
  assert.equal(safe.jobs.delivery, 'on', 'the loop job is classified and started (it idles while off)');
});

test('the development GET answers and writes exactly like the base build while the loop is off', { timeout: 600_000, skip: !process.env.DARK_CONTROL_BASE_DIR && 'set DARK_CONTROL_BASE_DIR to a checkout of the base build' }, async (t) => {
  const baseRepo = process.env.DARK_CONTROL_BASE_DIR;
  assert.ok(existsSync(join(baseRepo, 'server.js')) && existsSync(join(baseRepo, 'node_modules')), 'the base checkout needs server.js and node_modules');
  const seedDir = mkdtempSync(join(tmpdir(), 'asoldi-dark-seed-'));
  const baseData = mkdtempSync(join(tmpdir(), 'asoldi-dark-base-'));
  const branchData = mkdtempSync(join(tmpdir(), 'asoldi-dark-branch-'));
  t.after(() => [seedDir, baseData, branchData].forEach((dir) => rmSync(dir, { recursive: true, force: true })));
  seed(seedDir);
  cpSync(seedDir, baseData, { recursive: true });
  cpSync(seedDir, branchData, { recursive: true });
  const base = await developmentRound(baseRepo, baseData);
  await base.hub.stop();
  const branch = await developmentRound(REPO, branchData);
  await branch.hub.stop();
  assert.equal(maskRunTimes(branch.body), maskRunTimes(base.body), 'GET /api/admin/development answers the same');
  for (const name of ['sales-clients.json', 'sites.json', 'developer-owner-seed.json']) {
    const read = (dir) => (existsSync(join(dir, name)) ? maskRunTimes(readFileSync(join(dir, name), 'utf8')) : '<missing>');
    assert.equal(read(branchData), read(baseData), `${name} after the GET`);
  }
  const ignore = /^(backups|safe-mode|email-locks|secrets)\//;
  // Startup snapshots are named after the boot time.
  const filesOf = (dir) => listFiles(dir).filter((name) => !ignore.test(name)).map((name) => name.replace(/^snapshots\/batch-\d+-[0-9tz]+\//, 'snapshots/<boot>/'));
  assert.deepEqual(filesOf(branchData), filesOf(baseData), 'the same data files exist after boot and GET');
});
