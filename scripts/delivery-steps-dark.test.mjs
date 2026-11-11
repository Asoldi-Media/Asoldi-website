// The tick steps the delivery loop finds in this build, with the loop itself running for a pilot
// client and every other switch at its default (off): the step registry loads every step module,
// each step that has its own switch stops at that switch and writes, sends and fetches nothing, and
// a loop that is off runs no step at all. A positive control turns the gate on in shadow and shows
// that the comparison sees the writes a running step makes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-delivery-steps-'));
process.env.APP_DATA_DIR = DATA_DIR;
delete process.env.DATA_DIR;
for (const key of Object.keys(process.env)) if (/^(SMTP|RESEND|BREVO|EMAIL_REDIRECT)/.test(key)) delete process.env[key];
test.after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

const network = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  network.push(String(url));
  throw new Error(`no network in tests: ${url}`);
};
test.after(() => {
  globalThis.fetch = originalFetch;
});

const { installSafeMode, resetSafeModeForTests } = await import('../lib/safe-mode.js');
installSafeMode({ env: { HUB_SAFE_MODE: '1' }, dataDir: DATA_DIR, log: null, egress: false });
test.after(() => resetSafeModeForTests());

const settingsStore = await import('../data/automation-settings.js');
const sales = await import('../data/sales.js');
const { TICK_STEP_MODULES, loadTickSteps } = await import('../lib/delivery-steps.js');
const { createDeliveryLoop, resetDeliveryLoopForTests } = await import('../lib/delivery-loop.js');
test.after(() => resetDeliveryLoopForTests());

const PILOT = 'steps-pilot';
const START = '2026-11-03T10:00:00.000Z';
const END = '2026-11-03T11:00:00.000Z';
const DUE = '2026-11-03T13:00:00.000Z';
const NOW = Date.parse('2026-11-03T14:00:00.000Z');
const TIER1 = { status: 'active', tierId: 'tier-1-standard', services: ['site', 'changes', 'blog'], languages: ['nb'], billing: 'month', source: 'backfill' };

// The steps that carry a switch of their own, and the answer each gives when that switch stops it.
const OWN_SWITCH = {
  gate: (result) => result.skipped === 'gate-off',
  'brief-rebuild': (result) => result.status === 'brief-off',
  'post-workshop': (result) => result.skipped === 'mode-off',
  'data-reminder': (result) => result.skipped === 'mode-off',
  'retention-purge': (result) => result.ran === false && result.reason === 'disabled',
  'seo-transcript-keywords': (result) => result.skipped === 'switch-off',
  lifecycle: (result) => result.skipped === 'switch',
};

function writeSettings(extra = {}) {
  writeFileSync(join(DATA_DIR, 'automation-settings.json'), JSON.stringify({
    version: settingsStore.AUTOMATION_SETTINGS_VERSION,
    pilotClientIds: [PILOT],
    ...extra,
  }, null, 2));
  settingsStore.invalidateAutomationSettingsCache();
}

function treeHashes() {
  const out = {};
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(DATA_DIR, full).split('\\').join('/')] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  };
  walk(DATA_DIR);
  return out;
}

function changedFiles(before, after) {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((name) => before[name] !== after[name]).sort();
}

function stepContext(client, mode, settings) {
  return {
    now: NOW,
    settings,
    safeMode: true,
    log: { info() {}, warn() {}, error() {} },
    sales,
    hub: null,
    deps: {},
    dataDir: DATA_DIR,
    clients: client ? [{ client, reason: 'signed', mode }] : [],
    allClients: sales.getSalesClients(),
    loop: { previous: {}, dirty: {}, clockOverride: true, recentErrors: () => [], offSince: () => 0 },
    audit: () => {
      throw new Error('a step wrote a delivery-audit record');
    },
    shadow: () => {
      throw new Error('a step recorded a loop shadow record');
    },
    mode,
    ...(client ? { client } : {}),
  };
}

// A signed pilot whose workshop was held three hours ago and whose post-workshop mail is due: every
// time-based step would act for it if its switch let it.
sales.createSalesClient({
  id: PILOT,
  businessName: 'Example Studio AS',
  contactPerson: 'Kari Example',
  contactEmail: `${PILOT}@example.com`,
  product: 'asoldi',
  progression: { meetingHeld: true, offerSent: true, contractSigned: true, contractSignedAt: START },
  workshop: { heldAt: END },
});
sales.setSalesSitePlan(PILOT, TIER1, { by: 'test' });
sales.stampDeliveryEmail(PILOT, 'postWorkshopDueAt', DUE);

test('the step registry finds every step module of this build and loads it without errors', async () => {
  const { steps, loaded, errors } = await loadTickSteps();
  assert.deepEqual(errors, []);
  assert.deepEqual(loaded, [...TICK_STEP_MODULES], 'gate, brief, retention, jobs, emails, alerts, the SEO record and the contract lifecycle are all present');
  const names = steps.map((step) => step.name);
  for (const name of ['gate', 'brief-rebuild', 'retention-purge', 'jobs-requeue-stale', 'jobs-daily-snapshot', 'post-workshop', 'data-reminder', 'alerts', 'lifecycle']) {
    assert.ok(names.includes(name), `step ${name} is registered`);
  }
});

for (const loopMode of ['auto', 'shadow']) {
  test(`with the loop in ${loopMode} and every other switch off, each step with its own switch stops there and writes nothing`, async () => {
    writeSettings({ delivery: { loop: { enabled: true, mode: loopMode, paused: null } } });
    const settings = settingsStore.getAutomationSettings({ dataDir: DATA_DIR, fresh: true });
    const client = sales.getSalesClientById(PILOT);
    const { steps } = await loadTickSteps();
    const before = treeHashes();
    const sent = network.length;
    for (const step of steps) {
      const check = OWN_SWITCH[step.name];
      if (!check) continue;
      const result = step.scope === 'client'
        ? await step.run(stepContext(client, loopMode, settings), client)
        : await step.run(stepContext(null, loopMode, settings));
      assert.ok(!result?.wrote, `${step.name} wrote nothing`);
      assert.ok(check(result || {}), `${step.name} stopped at its own switch: ${JSON.stringify(result)}`);
    }
    assert.deepEqual(changedFiles(before, treeHashes()), [], 'the data dir is unchanged');
    assert.equal(network.length, sent, 'no network call');
  });
}

test('with the loop off a tick runs no step and writes nothing', async () => {
  writeSettings({});
  const loop = createDeliveryLoop({ dataDir: DATA_DIR, sales, log: { info() {}, warn() {}, error() {} } });
  const before = treeHashes();
  const result = await loop.tick({ now: NOW });
  assert.deepEqual(result, { ran: false, reason: 'disabled' });
  assert.deepEqual(changedFiles(before, treeHashes()), []);
  assert.equal(loop.health().ticks, 0);
});

test('positive control: with the gate on in shadow the gate and post-workshop steps act, and the comparison sees it', async () => {
  writeSettings({ delivery: { loop: { enabled: true, mode: 'auto', paused: null } }, gate: { enabled: true, mode: 'shadow', paused: null } });
  const settings = settingsStore.getAutomationSettings({ dataDir: DATA_DIR, fresh: true });
  const client = sales.getSalesClientById(PILOT);
  const { steps } = await loadTickSteps();
  const before = treeHashes();
  const gate = steps.find((step) => step.name === 'gate');
  const postWorkshop = steps.find((step) => step.name === 'post-workshop');
  const gateResult = await gate.run(stepContext(client, 'auto', settings), client);
  const mailResult = await postWorkshop.run(stepContext(client, 'auto', settings), client);
  assert.notEqual(gateResult.skipped, 'gate-off');
  assert.notEqual(mailResult.skipped, 'mode-off');
  const changed = changedFiles(before, treeHashes());
  assert.ok(changed.some((name) => name.startsWith('delivery-audit/')), `the gate's shadow evaluation is recorded: ${changed.join(', ')}`);
  assert.ok(changed.includes('delivery-email-shadow.json'), `the post-workshop shadow mail is recorded: ${changed.join(', ')}`);
});
