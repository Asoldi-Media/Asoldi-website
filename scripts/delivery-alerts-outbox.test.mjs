// Delivery alerts through the real mail path: a loop tick in safe mode with the loop in auto and
// no mail stub. The alert mail goes through lib/email.js into the safe-mode outbox, addressed to
// alerts.to, and no request leaves the process (fetch and sockets are spied on before safe mode is
// installed, so anything that got past the guard would show up there). Every tick runs on a fixed
// clock, so the result does not depend on the time of day the test runs (the daily digest starts at
// alerts.digestAt, 08:00 Oslo time by default). Temp data dir only.
//
// Run: node --test scripts/delivery-alerts-outbox.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-delivery-alerts-outbox-'));
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
const loopLib = await import('../lib/delivery-loop.js');
const alerts = await import('../lib/delivery-alerts.js');
const sales = await import('../data/sales.js');

test.after(() => {
  globalThis.fetch = realFetch;
  net.Socket.prototype.connect = realConnect;
  safeMode.resetSafeModeForTests();
  rmSync(dataDir, { recursive: true, force: true });
});

const MIN = 60 * 1000;
const quiet = { warn() {}, error() {}, log() {} };
// 2026-11-02 07:00 and 10:00 in Oslo: before and after the default digest time (08:00).
const BEFORE_DIGEST = Date.parse('2026-11-02T06:00:00.000Z');
const AFTER_DIGEST = Date.parse('2026-11-02T09:00:00.000Z');
const DAY = 24 * 60 * MIN;

function pausedLoopInAuto() {
  const saved = settingsStore.saveAutomationSettings(
    { pilotClientIds: ['p1'], alerts: { to: 'alerts@example.com' }, delivery: { loop: { enabled: true, mode: 'auto', paused: { reason: 'manual check' } } } },
    { by: 'test' },
  );
  assert.equal(saved.ok, true, JSON.stringify(saved.errors));
  settingsStore.invalidateAutomationSettingsCache();
  return saved.settings;
}

/** A loop on a clock the test moves (deps.now, so the stall check still runs). */
function loopAt(start) {
  const clock = { now: start };
  const loop = loopLib.createDeliveryLoop({ sales, hub: null, log: quiet, now: () => clock.now });
  return { loop, clock };
}

/** Clear the alert state and the loop files (a fresh hub), keeping the outbox. */
function freshAlertState() {
  rmSync(join(dataDir, 'delivery-hot'), { recursive: true, force: true });
  alerts.resetDeliveryAlertsMemoryForTests();
  loopLib.resetDeliveryLoopForTests();
}

function outboxIndex() {
  const file = join(dataDir, 'outbox', 'index.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
}

test('a new alert in auto lands in the safe-mode outbox for alerts.to; nothing leaves the process', async () => {
  safeMode.installSafeMode({ env: { HUB_SAFE_MODE: '1' }, dataDir, log: null });
  writeFileSync(join(dataDir, 'sales-clients.json'), '[]');
  // A paused loop in auto with a pilot: the alert step still runs and reports the pause.
  pausedLoopInAuto();
  const { loop, clock } = loopAt(BEFORE_DIGEST);
  const result = await loop.tick();
  assert.equal(result.mode, 'paused');
  assert.ok(alerts.readAlertState().active['switch-paused:delivery.loop']);
  const index = outboxIndex();
  assert.equal(index.length, 1, 'one alert mail in the outbox');
  assert.deepEqual(index[0].to, ['alerts@example.com']);
  assert.match(String(index[0].subject || ''), /switch-paused/);
  assert.equal(fetchCalls.length, 0, 'no HTTP request');
  assert.deepEqual(socketCalls.filter((host) => !/^(127\.|localhost|::1)/.test(host)), [], 'no SMTP socket');
  clock.now += MIN;
  await loop.tick();
  assert.equal(outboxIndex().length, 1, 'still active: no second mail');
});

test('the first alert after the digest time is one mail: no digest of that same alert', async () => {
  freshAlertState();
  pausedLoopInAuto();
  const before = outboxIndex().length;
  const { loop, clock } = loopAt(AFTER_DIGEST);
  assert.equal((await loop.tick()).mode, 'paused');
  const sent = outboxIndex().slice(before);
  assert.deepEqual(sent.map((row) => row.subject), ['[Asoldi] Leveransevarsel: switch-paused'], 'the alert mail and nothing else');
  assert.deepEqual(sent[0].to, ['alerts@example.com']);
  assert.equal(alerts.readAlertState().lastDigestDay, '2026-11-02', "today's digest counts as sent");
  clock.now += MIN;
  await loop.tick();
  clock.now += 13 * MIN;
  await loop.tick();
  assert.equal(outboxIndex().length, before + 1, 'no digest on later ticks either');
  assert.equal(fetchCalls.length, 0, 'no HTTP request');
});

test('the next day after the digest time a still active alert comes in the digest', async () => {
  // The alert from the previous test is active and was mailed yesterday. Called directly (no loop),
  // so the day without ticks is no stall; the mail still goes through lib/email.js.
  const settings = settingsStore.getAutomationSettings({ fresh: true });
  const before = outboxIndex().length;
  const conditions = alerts.currentAlerts({ settings, now: AFTER_DIGEST + DAY });
  assert.deepEqual(conditions.map((alert) => alert.key), ['switch-paused:delivery.loop']);
  const early = await alerts.processAlerts({ now: AFTER_DIGEST + DAY - 3 * 60 * MIN, settings, conditions, log: quiet });
  assert.equal(early.digest, false, '07:00: before the digest time');
  const due = await alerts.processAlerts({ now: AFTER_DIGEST + DAY, settings, conditions, log: quiet });
  assert.equal(due.digest, true);
  const sent = outboxIndex().slice(before);
  assert.deepEqual(sent.map((row) => row.subject), ['[Asoldi] Leveransevarsler: 1 aktive']);
  assert.deepEqual(sent[0].to, ['alerts@example.com']);
  assert.equal((await alerts.processAlerts({ now: AFTER_DIGEST + DAY + MIN, settings, conditions, log: quiet })).digest, false, 'once a day');
  assert.equal(outboxIndex().length, before + 1);
  assert.equal(fetchCalls.length, 0, 'no HTTP request');
  assert.deepEqual(socketCalls.filter((host) => !/^(127.|localhost|::1)/.test(host)), [], 'no SMTP socket');
});
