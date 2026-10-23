#!/usr/bin/env node
/**
 * Safe-mode soak: run the hub (API only) in safe mode with the egress recorder, drive the
 * actions that would touch the outside world, and prove that nothing left the PC except
 * loopback and the read-only hosts in scripts/safe-mode/soak-allowlist.json.
 *
 *   node scripts/safe-mode-soak.mjs --minutes 3 [--env-file <live .env>] [--port 3191] [--keep]
 *
 * - Fresh data dir .local-data/soak (seeded with synthetic clients on example.invalid).
 * - HUB_SAFE_MODE=1 and an empty HUB_SAFE_MODE_ALLOW are forced: this soaks the default profile.
 * - EGRESS_AUDIT_ENFORCE=1: an unlisted host is also refused by the recorder (safety net), and
 *   still fails the soak.
 * Pass: /api/health safeMode:true, 0 unlisted hosts, >= 1 outbox email for the due reminder,
 * an intent for every blocked drive action. Prints names and counts only, never env values.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, createWriteStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { planDevSafe, portInUse, readEnvFile } from './dev-safe.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST = join(REPO_ROOT, 'scripts', 'safe-mode', 'soak-allowlist.json');

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Synthetic data: one client with a due 24h reminder, a website snapshot for the prod-publish probe. */
export function seedSoakData(dataDir, now = new Date()) {
  mkdirSync(dataDir, { recursive: true });
  const iso = (offsetMs) => new Date(now.getTime() + offsetMs).toISOString();
  const client = {
    id: 'soak-client-1',
    product: 'asoldi',
    businessName: 'Soak Test Bakeri AS',
    contactPerson: 'Soak Testperson',
    contactEmail: 'soak-client@example.invalid',
    phone: '+47 400 00 000',
    city: 'Oslo',
    ownerId: 'sales:soak-rep',
    status: 'booked',
    agreedTime: true,
    meetingAt: iso(2 * 60 * 60 * 1000),
    meetingMode: 'in-person',
    meetingAddress: 'Testveien 1, 0000 Oslo',
    createdAt: iso(-3 * 24 * 60 * 60 * 1000),
    updatedAt: iso(-60 * 1000),
    reminders: {
      thankYouSentAt: iso(-24 * 60 * 60 * 1000),
      reminder3dAt: '',
      reminder3dSentAt: '',
      reminder24hAt: iso(-5 * 60 * 1000),
      reminder24hSentAt: '',
      reminder1hAt: iso(60 * 60 * 1000),
      reminder1hSentAt: '',
    },
  };
  writeFileSync(join(dataDir, 'sales-clients.json'), JSON.stringify([client], null, 2));
  const snapshot = join(dataDir, 'sales-site-imports', client.id);
  mkdirSync(snapshot, { recursive: true });
  writeFileSync(join(snapshot, 'index.html'), '<!doctype html><title>soak</title><p>soak snapshot</p>');
  return { clientId: client.id };
}

export function analyzeEgress(lines = []) {
  const rows = lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
  const byHost = {};
  for (const row of rows) {
    const key = `${row.host}:${row.port}`;
    byHost[key] = byHost[key] || { host: row.host, port: row.port, listed: row.listed, count: 0 };
    byHost[key].count += 1;
  }
  const unlisted = Object.values(byHost).filter((row) => !row.listed);
  return { total: rows.length, hosts: Object.values(byHost), unlisted };
}

async function waitForHealth(base, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return await res.json();
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error('hub did not answer /api/health');
}

async function call(base, path, { method = 'GET', token = '', body } = {}) {
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  } catch (error) {
    return { status: 0, json: { message: String(error?.message || error) } };
  }
}

function localAdminPassword(dataDir, envMap) {
  if (String(envMap.ADMIN_PASSWORD || '').trim()) return String(envMap.ADMIN_PASSWORD).trim();
  const file = join(dataDir, 'secrets', 'initial-admin-password');
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
}

export async function main(argv = process.argv.slice(2)) {
  const minutes = Math.max(1, Number(argValue(argv, '--minutes')) || 3);
  const port = Number(argValue(argv, '--port')) || 3191;
  const envFile = argValue(argv, '--env-file');
  const fileEnv = envFile ? readEnvFile(resolve(envFile)) : {};
  const shellEnv = { ...process.env };
  delete shellEnv.HUB_SAFE_MODE_ALLOW;
  delete shellEnv.EMAIL_REDIRECT_TO;
  const plan = planDevSafe({ argv: ['--profile', 'soak', '--api-port', String(port), '--ui-port', String(port + 1), '--egress-audit'], shellEnv, fileEnv, repoRoot: REPO_ROOT });
  const env = {
    ...plan.apiEnv,
    HUB_SAFE_MODE: '1',
    HUB_SAFE_MODE_ALLOW: '',
    EMAIL_REDIRECT_TO: '',
    APP_URL: `http://127.0.0.1:${port}`,
    SALES_EMAIL_AUTOSEND: '1',
    SALES_REMINDER_POLL_MS: '15000',
    PROD_ADMIN_URL: String(plan.apiEnv.PROD_ADMIN_URL || 'https://asoldi.com'),
    EGRESS_AUDIT_ALLOW: ALLOWLIST,
    EGRESS_AUDIT_ENFORCE: '1',
  };
  if (await portInUse(port)) throw new Error(`port ${port} is in use`);
  rmSync(plan.dataDir, { recursive: true, force: true });
  const { clientId } = seedSoakData(plan.dataDir);
  const auditFile = env.EGRESS_AUDIT_FILE;
  const logFile = join(plan.dataDir, 'hub.log');
  const log = createWriteStream(logFile);
  console.log(`[soak] ${minutes} min, port ${port}, data .local-data/soak, env file ${envFile ? 'loaded' : '(none)'} (${Object.keys(fileEnv).length} keys)`);
  const child = spawn(process.execPath, ['server.js'], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const base = `http://127.0.0.1:${port}`;
  const report = { ok: false, checks: {}, drive: {}, egress: null, intents: {}, outbox: 0 };
  try {
    const health = await waitForHealth(base);
    report.checks.healthSafeMode = health.safeMode === true;
    await sleep(2000);
    const password = localAdminPassword(plan.dataDir, env);
    const login = await call(base, '/api/admin/login', { method: 'POST', body: { username: env.ADMIN_USERNAME || 'asoldi.com', password } });
    const token = login.json?.token || '';
    report.checks.localAdminLogin = Boolean(token);
    // Drive: each of these would reach a real system without safe mode.
    const drive = {
      prodPublish: await call(base, `/api/admin/sales/${clientId}/publish-preview-to-prod`, { method: 'POST', token }),
      stripeWebhookAdmin: await call(base, '/api/hub/payments-platform/stripe-webhook', { method: 'POST', token }),
      publicTunnel: await call(base, '/api/admin/sales/maker-tunnel/start', { method: 'POST', token, body: {} }),
      infokort: await call(base, '/api/admin/sales/refresh-upcoming-links', { method: 'POST', token, body: {} }),
      firefliesRefresh: await call(base, '/api/admin/fireflies/meetings/soak-meeting/refresh', { method: 'POST', token }),
    };
    for (const [name, result] of Object.entries(drive)) report.drive[name] = result.status;
    const deadline = Date.now() + minutes * 60_000;
    while (Date.now() < deadline) await sleep(5000);
    const state = await call(base, '/api/admin/system/safe-mode?intents=500', { token });
    const outbox = await call(base, '/api/admin/system/outbox?limit=50', { token });
    report.outbox = Number(outbox.json?.total || 0);
    for (const intent of state.json?.intents || []) report.intents[intent.kind] = (report.intents[intent.kind] || 0) + 1;
    report.counters = state.json?.counters || {};
    report.jobs = state.json?.jobs || {};
  } finally {
    child.kill('SIGTERM');
    await sleep(1500);
    if (child.exitCode === null) child.kill('SIGKILL');
    log.end();
  }
  const lines = existsSync(auditFile) ? readFileSync(auditFile, 'utf8').split('\n').filter(Boolean) : [];
  report.egress = analyzeEgress(lines);
  report.checks.zeroUnlistedEgress = report.egress.unlisted.length === 0;
  report.checks.outboxHasReminder = report.outbox >= 1;
  report.checks.prodPublishIntent = Boolean(report.intents.prodPublish);
  report.checks.stripeWebhookAdminIntent = Boolean(report.intents.stripeWebhookAdmin);
  report.checks.publicTunnelIntent = Boolean(report.intents.publicTunnel);
  report.ok = Object.values(report.checks).every(Boolean);
  writeFileSync(join(plan.dataDir, 'soak-report.json'), JSON.stringify(report, null, 2));
  console.log(`[soak] egress connections=${report.egress.total} hosts=${report.egress.hosts.map((h) => `${h.host}:${h.port}x${h.count}${h.listed ? '' : ' UNLISTED'}`).join(', ') || '(none)'}`);
  console.log(`[soak] intents ${JSON.stringify(report.intents)}`);
  console.log(`[soak] outbox=${report.outbox} drive=${JSON.stringify(report.drive)}`);
  for (const [name, pass] of Object.entries(report.checks)) console.log(`[soak] ${pass ? 'PASS' : 'FAIL'} ${name}`);
  console.log(`[soak] ${report.ok ? 'PASSED' : 'FAILED'} (report: .local-data/soak/soak-report.json, hub log: .local-data/soak/hub.log)`);
  if (!argv.includes('--keep') && report.ok) {
    // keep the report and log, drop the seeded data and outbox
    for (const name of ['sales-clients.json', 'sales-site-imports', 'outbox']) rmSync(join(plan.dataDir, name), { recursive: true, force: true });
  }
  return report.ok ? 0 : 1;
}

function isDirectRun() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(`[soak] ${error?.message || error}`);
    process.exit(1);
  });
}
