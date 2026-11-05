// CMS fleet monitor in safe mode: the daily digest goes through lib/email.js into the safe-mode
// outbox, addressed to alerts.to, with no request leaving the process (fetch and sockets are spied
// on before safe mode is installed), and the review only reports: a proposal older than 3 days is
// not applied even with autoApplyFlip on. The health ping pings loopback hosts only. Temp data dir,
// invented sites.
//
// Run: node --test scripts/cms-fleet-monitor-outbox.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-cms-fleet-outbox-'));
process.env.APP_DATA_DIR = dataDir;
process.env.DATA_DIR = '';
process.env.PERSIST_PRODUCTION_ENV = '0';
// A configured transport, so a send that got past safe mode would reach the spies below.
Object.assign(process.env, {
  RESEND_API_KEY: 're_fake_for_tests',
  RESEND_FROM: 'Asoldi <contact@example.com>',
  SMTP_HOST: 'smtp.example.com',
  SMTP_PORT: '587',
  SMTP_USER: 'contact@example.com',
  SMTP_PASS: 'fake-pass',
});

const fetchCalls = [];
const socketCalls = [];
const realFetch = globalThis.fetch;
const realConnect = net.Socket.prototype.connect;
globalThis.fetch = async (input) => {
  fetchCalls.push(String(input?.url || input));
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};
net.Socket.prototype.connect = function spyConnect(...args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  socketCalls.push(String((first && typeof first === 'object' ? first.host : args[1]) || 'localhost'));
  const error = Object.assign(new Error('test: no network'), { code: 'ETESTNONET' });
  process.nextTick(() => this.destroy(error));
  return this;
};

const safeMode = await import('../lib/safe-mode.js');
const settingsStore = await import('../data/automation-settings.js');
const featureSettingsStore = await import('../data/cms-feature-settings.js');
const hub = await import('../data/hub.js');
const monitor = await import('../lib/cms-fleet-monitor.js');
const { readOutboxItem } = await import('../lib/safe-mode-outbox.js');

test.after(() => {
  globalThis.fetch = realFetch;
  net.Socket.prototype.connect = realConnect;
  safeMode.resetSafeModeForTests();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const quiet = { warn() {}, error() {}, log() {} };
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// 2026-11-10 09:00 in Oslo.
const NOW = Date.parse('2026-11-10T08:00:00.000Z');

function cleanWeek(base) {
  return Array.from({ length: 7 }, (_, i) => ({ date: monitor.osloDay(base - (6 - i) * DAY), count: 0, top: [] }));
}

function writeSites(base) {
  const seen = new Date(base - 2 * HOUR).toISOString();
  const old = new Date(base - 30 * HOUR).toISOString();
  const site = (id, name, domain, cms = {}) => ({
    id,
    site_key: `key-${id}-0001`,
    domain,
    name,
    websitePlan: 'tier-1-standard',
    features: { users: true },
    featureEnforcement: 'log',
    cms: { packageVersion: '2.3.0', lastSeenAt: seen, lastVerifiedAt: seen, featuresRev: 2, blockHistory: cleanWeek(base), ...cms },
  });
  writeFileSync(join(dataDir, 'sites.json'), JSON.stringify([
    site('sa', 'Solberg Sko', 'solberg.test'),
    site('sb', 'Stille Sag', 'stille.test', { lastSeenAt: old, lastVerifiedAt: old }),
    site('sl', 'Lokal Prøve', '127.0.0.1:9'),
  ], null, 2));
}

function outboxIndex() {
  const file = join(dataDir, 'outbox', 'index.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
}

function autoSettings() {
  const saved = settingsStore.saveAutomationSettings(
    { alerts: { to: 'staff@example.com' }, cmsFleet: { monitor: { enabled: true, mode: 'auto' }, autoApplyFlip: true, wakePing: { enabled: true } } },
    { by: 'test' },
  );
  assert.equal(saved.ok, true, JSON.stringify(saved.errors));
  settingsStore.invalidateAutomationSettingsCache();
  return saved.settings;
}

test('in safe mode the digest lands in the outbox for alerts.to and nothing leaves the process', async () => {
  safeMode.installSafeMode({ env: { HUB_SAFE_MODE: '1' }, dataDir, log: null });
  featureSettingsStore.saveCmsFeatureSettings({ siteConfig: { mode: 'on', siteIds: ['sa', 'sb', 'sl'] } }, { dataDir, by: 'test' });
  autoSettings();
  writeSites(NOW);
  const result = await monitor.runFleetReview({ hub, now: NOW, log: quiet });
  assert.equal(result.ran, true);
  assert.equal(result.mailed, true);
  assert.deepEqual(result.proposals.sort(), ['sa', 'sl']);
  const index = outboxIndex();
  assert.equal(index.length, 1, 'one digest in the outbox');
  assert.deepEqual(index[0].to, ['staff@example.com']);
  assert.match(String(index[0].subject), /^\[Asoldi\] CMS-flåten: 3 merknader$/);
  const body = String(readOutboxItem(dataDir, index[0].id)?.text || '');
  assert.match(body, /Ingen kontakt på over 24 timer/);
  assert.match(body, /Stille Sag/);
  assert.match(body, /Forslag: slå på håndheving/);
  assert.equal(fetchCalls.length, 0, 'no HTTP request');
  assert.deepEqual(socketCalls.filter((host) => !/^(127\.|localhost|::1)/.test(host)), [], 'no SMTP socket');
});

test('in safe mode the review only reports: an old proposal is not applied even with autoApplyFlip on', async () => {
  const settings = autoSettings();
  for (const days of [1, 2, 3, 4]) {
    writeSites(NOW + days * DAY);
    const result = await monitor.runFleetReview({ hub, settings, now: NOW + days * DAY, log: quiet });
    assert.equal(result.ran, true);
    assert.deepEqual(result.applied, []);
  }
  const state = monitor.readFleetState({ dataDir });
  assert.equal(state.sites.sa.proposal.status, 'open');
  assert.ok(Date.parse(state.sites.sa.proposal.since) <= NOW, 'open for more than 3 days');
  const stored = JSON.parse(readFileSync(join(dataDir, 'sites.json'), 'utf8'));
  assert.deepEqual(stored.map((site) => site.featureEnforcement), ['log', 'log', 'log']);
  assert.equal(outboxIndex().length, 5, 'one digest a day, all in the outbox');
  assert.equal(fetchCalls.length, 0);
});

test('in safe mode the health ping skips public hosts and pings loopback only', async () => {
  writeSites(NOW);
  const result = await monitor.wakePing({ hub, now: NOW, timeoutMs: 500 });
  assert.equal(result.ran, true);
  assert.equal(result.results.sa.skipped, 'safe-mode');
  assert.equal(result.results.sb.skipped, 'safe-mode');
  assert.equal(result.results.sl.skipped, undefined, 'a loopback host is pinged');
  assert.equal(result.results.sl.status, 200, 'answered by the fetch spy');
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0], 'http://127.0.0.1:9/api/cms/health');
});

test('the safe-mode job plan starts the report-only review and leaves the health ping off', () => {
  const plan = safeMode.backgroundJobPlan();
  assert.equal(plan.cmsEnforcement, 'on');
  assert.equal(plan.cmsWakePing, 'off');
});
