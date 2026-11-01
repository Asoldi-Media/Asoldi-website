// Delivery alerts through the real mail path: a loop tick in safe mode with the loop in auto and
// no mail stub. The alert mail goes through lib/email.js into the safe-mode outbox, addressed to
// alerts.to, and no request leaves the process (fetch and sockets are spied on before safe mode is
// installed, so anything that got past the guard would show up there). Temp data dir only.
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

function outboxIndex() {
  const file = join(dataDir, 'outbox', 'index.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
}

test('a new alert in auto lands in the safe-mode outbox for alerts.to; nothing leaves the process', async () => {
  safeMode.installSafeMode({ env: { HUB_SAFE_MODE: '1' }, dataDir, log: null });
  writeFileSync(join(dataDir, 'sales-clients.json'), '[]');
  // A paused loop in auto with a pilot: the alert step still runs and reports the pause.
  const saved = settingsStore.saveAutomationSettings(
    { pilotClientIds: ['p1'], alerts: { to: 'alerts@example.com' }, delivery: { loop: { enabled: true, mode: 'auto', paused: { reason: 'manual check' } } } },
    { by: 'test' },
  );
  assert.equal(saved.ok, true, JSON.stringify(saved.errors));
  settingsStore.invalidateAutomationSettingsCache();
  const loop = loopLib.createDeliveryLoop({ sales, hub: null, log: { warn() {}, error() {}, log() {} } });
  const result = await loop.tick();
  assert.equal(result.mode, 'paused');
  assert.ok(alerts.readAlertState().active['switch-paused:delivery.loop']);
  const index = outboxIndex();
  assert.equal(index.length, 1, 'one alert mail in the outbox');
  assert.deepEqual(index[0].to, ['alerts@example.com']);
  assert.match(String(index[0].subject || ''), /switch-paused/);
  assert.equal(fetchCalls.length, 0, 'no HTTP request');
  assert.deepEqual(socketCalls.filter((host) => !/^(127\.|localhost|::1)/.test(host)), [], 'no SMTP socket');
  await loop.tick();
  assert.equal(outboxIndex().length, 1, 'still active: no second mail');
});
