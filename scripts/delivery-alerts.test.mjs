// Delivery alerts: each condition fires once per dedupe window and clears when resolved; mail only
// in auto, through the mail function (the safe-mode outbox on a local hub); the daily digest; the
// boot gap check. Temp data dirs only.
//
// Run: node --test scripts/delivery-alerts.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-delivery-alerts-'));
process.env.APP_DATA_DIR = dataDir;
process.env.DATA_DIR = '';
process.env.PERSIST_PRODUCTION_ENV = '0';

const alerts = await import('../lib/delivery-alerts.js');
const settingsStore = await import('../data/automation-settings.js');
const { testReleases, writeReleasesFile } = await import('./fixtures/test-releases.mjs');
const loopLib = await import('../lib/delivery-loop.js');
const makerAuthLib = await import('../lib/maker-auth.js');
const { clearJsonCacheForTests } = await import('../data/atomic-json.js');

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-11-02T05:00:00.000Z'); // 06:00 in Oslo
const quiet = { warn() {}, error() {}, log() {} };

function settingsWith(patch = {}) {
  return settingsStore.validateAutomationSettings(patch, { current: { releases: testReleases() } }).value;
}

const autoSettings = (extra = {}) => settingsWith({ pilotClientIds: ['p1'], delivery: { loop: { enabled: true, mode: 'auto' } }, ...extra });
const shadowSettings = () => settingsWith({ delivery: { loop: { enabled: true, mode: 'shadow' } } });

function reset() {
  for (const name of readdirSync(dataDir)) rmSync(join(dataDir, name), { recursive: true, force: true });
  clearJsonCacheForTests();
  alerts.resetDeliveryAlertsMemoryForTests();
  loopLib.resetDeliveryLoopForTests();
}

const host = { hostId: 'mh_aaaaaa01', label: 'Test PC', scopes: ['jobs'], lastSeenAt: new Date(T0 - 3 * HOUR).toISOString() };
const queued = { id: 'job_aaaaaaaa01', kind: 'preview', salesClientId: 'c1', hostId: host.hostId, status: 'queued', createdAt: new Date(T0 - 4 * HOUR).toISOString() };

test('conditions: offline host with work, stuck job, stalled loop, step error, auth burst, paused switch', () => {
  const settings = autoSettings({ emails: { previewReady: { paused: { reason: 'bounce rate' } } } });
  const found = alerts.evaluateAlertConditions({
    now: T0,
    settings,
    hosts: [host, { ...host, hostId: 'mh_bbbbbb02', lastSeenAt: new Date(T0 - 10 * HOUR).toISOString() }],
    jobs: [
      queued,
      { id: 'job_bbbbbbbb02', kind: 'publish', salesClientId: 'c2', status: 'blocked', blocking: 'needs-confirm', updatedAt: new Date(T0 - 30 * HOUR).toISOString() },
      { id: 'job_cccccccc03', kind: 'publish', salesClientId: 'c3', status: 'blocked', updatedAt: new Date(T0 - 2 * HOUR).toISOString() },
    ],
    heartbeats: {},
    previousSuccessAt: new Date(T0 - 20 * 60 * 1000).toISOString(),
    recentErrors: [{ at: new Date(T0 - 60 * 1000).toISOString(), step: 'gate', error: 'boom' }, { at: new Date(T0 - 2 * HOUR).toISOString(), step: 'old', error: 'x' }],
    authBursts: [{ at: T0 - 60 * 1000, failures: 31 }],
  });
  assert.deepEqual(found.map((alert) => alert.key).sort(), [
    'host-offline:mh_aaaaaa01',
    'job-blocked:job_bbbbbbbb02',
    'loop-error:gate',
    'loop-stalled',
    'maker-auth-failures',
    'switch-paused:emails.previewReady',
  ], 'an idle host with no work and a recently blocked job raise nothing');
  const fresh = alerts.evaluateAlertConditions({ now: T0, settings, hosts: [host], jobs: [queued], heartbeats: { [host.hostId]: { lastHeartbeatAt: new Date(T0 - 60 * 1000).toISOString() } } });
  assert.equal(fresh.some((alert) => alert.kind === 'host-offline'), false, 'a recent heartbeat counts');
});

test('processAlerts: an alert starts and mails once, stays quiet while active, and clears when resolved', async () => {
  reset();
  const mails = [];
  const sendMail = async (message) => mails.push(message);
  const settings = autoSettings();
  const condition = { key: 'host-offline:mh_aaaaaa01', kind: 'host-offline', message: 'Maker-verten er borte.', data: {} };
  const first = await alerts.processAlerts({ now: T0, settings, conditions: [condition], sendMail, log: quiet });
  assert.deepEqual(first.started, ['host-offline:mh_aaaaaa01']);
  assert.deepEqual(first.mailed, ['host-offline:mh_aaaaaa01']);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'ansatte@asoldi.com');
  const again = await alerts.processAlerts({ now: T0 + 60_000, settings, conditions: [condition], sendMail, log: quiet });
  assert.equal(again.wrote, false);
  assert.equal(mails.length, 1, 'still active: no second mail');
  const cleared = await alerts.processAlerts({ now: T0 + 120_000, settings, conditions: [], sendMail, log: quiet });
  assert.deepEqual(cleared.cleared, ['host-offline:mh_aaaaaa01']);
  const state = alerts.readAlertState();
  assert.deepEqual(state.active, {});
  assert.equal(state.history.at(-1).key, 'host-offline:mh_aaaaaa01');
  const flap = await alerts.processAlerts({ now: T0 + 3 * HOUR, settings, conditions: [condition], sendMail, log: quiet });
  assert.deepEqual(flap.started, ['host-offline:mh_aaaaaa01']);
  assert.deepEqual(flap.mailed, [], 'within 6 hours of the last mail: no new mail');
  await alerts.processAlerts({ now: T0 + 4 * HOUR, settings, conditions: [], sendMail, log: quiet });
  const later = await alerts.processAlerts({ now: T0 + 7 * HOUR, settings, conditions: [condition], sendMail, log: quiet });
  assert.deepEqual(later.mailed, ['host-offline:mh_aaaaaa01'], 'after the window it mails again');
});

test('shadow records alerts and never mails; the digest goes out once a day after digestAt', async () => {
  reset();
  const mails = [];
  const sendMail = async (message) => mails.push(message);
  const condition = { key: 'loop-stalled', kind: 'loop-stalled', message: 'Løkken stod.', data: {} };
  const shadow = await alerts.processAlerts({ now: T0, settings: shadowSettings(), conditions: [condition], sendMail, log: quiet });
  assert.deepEqual(shadow.started, ['loop-stalled']);
  assert.deepEqual(mails, []);
  assert.ok(alerts.readAlertState().active['loop-stalled']);
  reset();
  const settings = autoSettings({ alerts: { digestAt: '07:30' } });
  await alerts.processAlerts({ now: T0, settings, conditions: [condition], sendMail, log: quiet }); // 06:00 Oslo
  assert.equal(mails.length, 1, 'the new alert mail');
  assert.equal((await alerts.processAlerts({ now: T0 + HOUR, settings, conditions: [condition], sendMail, log: quiet })).digest, false, '07:00 is before digestAt');
  const digest = await alerts.processAlerts({ now: T0 + 3 * HOUR, settings, conditions: [condition], sendMail, log: quiet });
  assert.equal(digest.digest, true);
  assert.match(mails.at(-1).subject, /1 aktive/);
  assert.equal((await alerts.processAlerts({ now: T0 + 5 * HOUR, settings, conditions: [condition], sendMail, log: quiet })).digest, false, 'once a day');
  assert.equal((await alerts.processAlerts({ now: T0 + 27 * HOUR, settings, conditions: [condition], sendMail, log: quiet })).digest, true, 'next day');
});

test("the first alert after digestAt is one mail and counts as the day's digest; an older alert brings the digest", async () => {
  reset();
  const mails = [];
  const sendMail = async (message) => mails.push(message);
  const settings = autoSettings();
  const hostAlert = { key: 'host-offline:mh_aaaaaa01', kind: 'host-offline', message: 'Maker-verten er borte.', data: {} };
  const jobAlert = { key: 'job-blocked:job_aaaaaaaa01', kind: 'job-blocked', message: 'Jobben står fast.', data: {} };
  // 10:00 in Oslo, after the default digest time (08:00).
  const first = await alerts.processAlerts({ now: T0 + 4 * HOUR, settings, conditions: [hostAlert], sendMail, log: quiet });
  assert.deepEqual(first.mailed, [hostAlert.key]);
  assert.equal(first.digest, false);
  assert.equal(first.digestCovered, true);
  assert.deepEqual(mails.map((mail) => mail.subject), ['[Asoldi] Leveransevarsel: host-offline'], 'one mail, not a mail and a digest of it');
  assert.equal(alerts.readAlertState().lastDigestDay, '2026-11-02');
  const second = await alerts.processAlerts({ now: T0 + 5 * HOUR, settings, conditions: [hostAlert, jobAlert], sendMail, log: quiet });
  assert.deepEqual(second.mailed, [jobAlert.key]);
  assert.equal(second.digest, false, "the day's digest is done");
  assert.equal(mails.length, 2);
  // Negative control: the same first alert before the digest time leaves the digest due, and the
  // first tick after 08:00 sends it.
  reset();
  mails.length = 0;
  await alerts.processAlerts({ now: T0, settings, conditions: [hostAlert], sendMail, log: quiet }); // 06:00 Oslo
  const due = await alerts.processAlerts({ now: T0 + 2 * HOUR + 60_000, settings, conditions: [hostAlert, jobAlert], sendMail, log: quiet }); // 08:01
  assert.deepEqual(due.mailed, [jobAlert.key]);
  assert.equal(due.digest, true, 'an alert mailed before 08:00 is in the digest');
  assert.deepEqual(mails.map((mail) => mail.subject), ['[Asoldi] Leveransevarsel: host-offline', '[Asoldi] Leveransevarsel: job-blocked', '[Asoldi] Leveransevarsler: 2 aktive']);
});

test('boot gap check: the first tick after a 20-minute outage raises loop-stalled once', async () => {
  reset();
  writeFileSync(join(dataDir, 'sales-clients.json'), '[]');
  settingsStore.invalidateAutomationSettingsCache();
  // The loop was switched on an hour ago and last ticked 20 minutes ago: a real outage.
  // Auto needs a recorded release pass (lib/spine-mode.js).
  writeReleasesFile(dataDir);
  settingsStore.invalidateAutomationSettingsCache();
  settingsStore.saveAutomationSettings({ pilotClientIds: ['p1'], delivery: { loop: { enabled: true, mode: 'auto' } } }, { by: 'test', now: new Date(Date.now() - 60 * 60 * 1000) });
  settingsStore.invalidateAutomationSettingsCache();
  mkdirSync(join(dataDir, 'delivery-hot'), { recursive: true });
  const lastSuccess = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  writeFileSync(join(dataDir, 'delivery-hot', 'loop-health.json'), JSON.stringify({ lastTickAt: lastSuccess, lastSuccessAt: lastSuccess }));
  const mails = [];
  const sales = await import('../data/sales.js');
  const loop = loopLib.createDeliveryLoop({ sales, hub: null, log: quiet, sendMail: async (message) => mails.push(message) });
  const first = await loop.tick();
  assert.equal(first.ran, true);
  assert.deepEqual(first.steps.alerts ? alerts.readAlertState().active['loop-stalled']?.kind : null, 'loop-stalled');
  assert.equal(mails.filter((mail) => /loop-stalled/.test(mail.subject)).length, 1);
  await loop.tick();
  assert.equal(alerts.readAlertState().active['loop-stalled'], undefined, 'it clears once the loop ticks again');
  assert.equal(mails.filter((mail) => /loop-stalled/.test(mail.subject)).length, 1);
});

test('no stall after the loop was off: a success from before the switch-on is no outage', async () => {
  reset();
  writeFileSync(join(dataDir, 'sales-clients.json'), '[]');
  settingsStore.invalidateAutomationSettingsCache();
  mkdirSync(join(dataDir, 'delivery-hot'), { recursive: true });
  const oldSuccess = new Date(Date.now() - 3 * HOUR).toISOString();
  writeFileSync(join(dataDir, 'delivery-hot', 'loop-health.json'), JSON.stringify({ lastTickAt: oldSuccess, lastSuccessAt: oldSuccess }));
  // Switched on (again) just now, after three hours off: the settings audit says so.
  writeReleasesFile(dataDir);
  settingsStore.invalidateAutomationSettingsCache();
  settingsStore.saveAutomationSettings({ pilotClientIds: ['p1'], delivery: { loop: { enabled: true, mode: 'auto' } } }, { by: 'test' });
  settingsStore.invalidateAutomationSettingsCache();
  const mails = [];
  const sales = await import('../data/sales.js');
  const loop = loopLib.createDeliveryLoop({ sales, hub: null, log: quiet, sendMail: async (message) => mails.push(message) });
  assert.equal((await loop.tick()).ran, true);
  assert.equal(alerts.readAlertState().active['loop-stalled'], undefined);
  assert.equal(mails.length, 0);

  // Off and on again inside one process, with no audit entry (a hand edit of the file).
  reset();
  writeFileSync(join(dataDir, 'sales-clients.json'), '[]');
  const write = (enabled) => {
    writeFileSync(join(dataDir, 'automation-settings.json'), JSON.stringify({ version: 2, pilotClientIds: ['p1'], releases: testReleases(), delivery: { loop: { enabled, mode: 'auto', paused: null } } }));
    settingsStore.invalidateAutomationSettingsCache();
  };
  let clock = Date.now() - 2 * HOUR;
  const memoryLoop = loopLib.createDeliveryLoop({ sales, hub: null, log: quiet, now: () => clock, sendMail: async (message) => mails.push(message) });
  write(true);
  assert.equal((await memoryLoop.tick()).ran, true);
  write(false);
  clock += HOUR;
  assert.equal((await memoryLoop.tick()).ran, false, 'off: the tick does nothing');
  write(true);
  clock += HOUR;
  assert.equal((await memoryLoop.tick()).ran, true);
  assert.equal(alerts.readAlertState().active['loop-stalled'], undefined, 'the gap was the off period');
  assert.equal(mails.filter((mail) => /loop-stalled/.test(mail.subject)).length, 0);
  // Negative control: the same two-hour gap with the loop on the whole time is an outage.
  clock += 2 * HOUR;
  await memoryLoop.tick();
  assert.ok(alerts.readAlertState().active['loop-stalled'], 'a gap while on is reported');
});

test('alert state that cannot be written never sends the same mail again', async () => {
  reset();
  const mails = [];
  const sendMail = async (message) => mails.push(message);
  const settings = autoSettings();
  // A folder where the state file belongs: every write of it fails.
  mkdirSync(join(dataDir, 'delivery-hot', 'alerts.json'), { recursive: true });
  const condition = { key: 'host-offline:mh_aaaaaa01', kind: 'host-offline', message: 'Maker-verten er borte.', data: {} };
  await assert.rejects(alerts.processAlerts({ now: T0, settings, conditions: [condition], sendMail, log: quiet }));
  assert.equal(mails.length, 1, 'the first mail went out');
  await assert.rejects(alerts.processAlerts({ now: T0 + 60_000, settings, conditions: [condition], sendMail, log: quiet }));
  await assert.rejects(alerts.processAlerts({ now: T0 + 120_000, settings, conditions: [condition], sendMail, log: quiet }));
  assert.equal(mails.length, 1, 'no second mail while the state cannot be stored');
  // Negative control: a fresh process (memory cleared) with the same broken state does mail again.
  alerts.resetDeliveryAlertsMemoryForTests();
  await assert.rejects(alerts.processAlerts({ now: T0 + 180_000, settings, conditions: [condition], sendMail, log: quiet }));
  assert.equal(mails.length, 2);
});

test('a tick on a test clock never reports a stall', async () => {
  reset();
  writeFileSync(join(dataDir, 'sales-clients.json'), '[]');
  settingsStore.invalidateAutomationSettingsCache();
  settingsStore.saveAutomationSettings({ delivery: { loop: { enabled: true, mode: 'shadow' } } }, { by: 'test' });
  settingsStore.invalidateAutomationSettingsCache();
  const sales = await import('../data/sales.js');
  const loop = loopLib.createDeliveryLoop({ sales, hub: null, log: quiet, sendMail: async () => {} });
  await loop.tick({ now: T0 });
  await loop.tick({ now: T0 + 3 * 24 * HOUR });
  assert.equal(alerts.readAlertState().active['loop-stalled'], undefined);
});

test('Maker auth: more than 30 refusals in 10 minutes reach the alert list through onAlert', () => {
  reset();
  let clock = T0;
  const auth = makerAuthLib.createMakerAuth({ legacyHolder: null, dataDir, env: {}, now: () => clock, onAlert: alerts.noteMakerAuthAlert });
  for (let i = 0; i < 32; i += 1) {
    clock += 1000;
    auth.checkMakerRequest({ headers: { 'x-maker-host-token': `mkr_abcdef12_${'x'.repeat(43)}` } }, { scope: 'jobs' });
  }
  const found = alerts.currentAlerts({ dataDir, settings: autoSettings(), now: clock });
  assert.ok(found.some((alert) => alert.key === 'maker-auth-failures'));
  assert.equal(alerts.currentAlerts({ dataDir, settings: autoSettings(), now: clock + 11 * 60 * 1000 }).some((alert) => alert.key === 'maker-auth-failures'), false, 'gone after the window');
});

test('pause events: a paused loop still runs the alert step and reports the pause', async () => {
  reset();
  writeFileSync(join(dataDir, 'sales-clients.json'), '[]');
  settingsStore.invalidateAutomationSettingsCache();
  settingsStore.saveAutomationSettings({ delivery: { loop: { enabled: true, mode: 'shadow', paused: { reason: 'manual check' } } } }, { by: 'test' });
  settingsStore.invalidateAutomationSettingsCache();
  const sales = await import('../data/sales.js');
  const loop = loopLib.createDeliveryLoop({ sales, hub: null, log: quiet, sendMail: async () => {} });
  const result = await loop.tick({ now: T0 });
  assert.equal(result.mode, 'paused');
  assert.ok(alerts.readAlertState().active['switch-paused:delivery.loop']);
});
