// Delivery gate: the requirement table, the evaluation, page-kind lines, waivers, the tick step,
// the gate-f1 label check and the negative controls (gate off: nothing evaluated or written).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-gate-'));
process.env.APP_DATA_DIR = DATA_DIR;
delete process.env.DATA_DIR;
delete process.env.STRIPE_CONNECT_SECRET_KEY;
delete process.env.STRIPE_CONNECT_TEST_SECRET_KEY;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vocab = await import('../packages/suite/core/delivery/vocab.js');
const settingsStore = await import('../data/automation-settings.js');
const sales = await import('../data/sales.js');
const hub = await import('../data/hub.js');
const gateLib = await import('../lib/delivery-gate.js');
const { SERVICE_REQUIREMENTS, bankColorsAreDefault } = await import('../lib/site-plan-requirements.js');
const { PAGE_KIND_REQUIREMENTS, pageKindFromLabel, pageKindsForClient } = await import('../lib/page-kind-requirements.js');
const shop = await import('../lib/shop-payments.js');
const { gateF1 } = await import('./eval/gate-f1.mjs');

const NOW = '2026-11-02T10:00:00.000Z';
const TIER1 = { status: 'active', tierId: 'tier-1-standard', services: ['site', 'changes', 'blog'], languages: ['nb'], billing: 'month', source: 'backfill' };
const TIER2 = { ...TIER1, tierId: 'tier-2-seo', services: vocab.servicesForTier('tier-2-seo') };
const TIER3 = { ...TIER1, tierId: 'tier-3-ecommerce', services: vocab.servicesForTier('tier-3-ecommerce') };
const PRODUCT_LINES = ['products', 'seller', 'shipping', 'returns', 'payment', 'catalog-items'];

function setGate(patch) {
  const result = settingsStore.saveAutomationSettings(patch);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  settingsStore.invalidateAutomationSettingsCache();
}

function evaluate(client, inputs = {}) {
  return gateLib.evaluateDeliveryGate(client, inputs, { now: NOW });
}

function ids(gate) {
  return gate.lines.map((line) => line.id);
}

function line(gate, id) {
  return gate.lines.find((entry) => entry.id === id);
}

function seed(id, extra = {}) {
  const client = sales.createSalesClient({
    id,
    businessName: 'Example business',
    contactEmail: `${id}@example.com`,
    product: 'asoldi',
    progression: { contractSigned: true },
    ...extra,
  });
  return client;
}

function withPlan(id, plan) {
  sales.setSalesSitePlan(id, plan, { by: 'test', reason: 'seed' });
  return sales.getSalesClientById(id);
}

// Counts every outbound call: fetch, the http/https/net helpers (also through named ESM imports
// such as `import { request } from 'node:https'`, via syncBuiltinESMExports) and any socket connect.
function spyNetwork() {
  const calls = [];
  const originals = {
    fetch: globalThis.fetch,
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
    connect: net.connect,
    createConnection: net.createConnection,
    socketConnect: net.Socket.prototype.connect,
  };
  globalThis.fetch = async (...args) => { calls.push(['fetch', String(args[0])]); throw new Error('no network in tests'); };
  http.request = (...args) => { calls.push(['http.request']); throw new Error('no network'); };
  http.get = (...args) => { calls.push(['http.get']); throw new Error('no network'); };
  https.request = (...args) => { calls.push(['https.request']); throw new Error('no network'); };
  https.get = (...args) => { calls.push(['https.get']); throw new Error('no network'); };
  net.connect = (...args) => { calls.push(['net.connect']); throw new Error('no network'); };
  net.createConnection = (...args) => { calls.push(['net.createConnection']); throw new Error('no network'); };
  net.Socket.prototype.connect = function connect() { calls.push(['socket.connect']); throw new Error('no network'); };
  syncBuiltinESMExports();
  return {
    calls,
    restore() {
      globalThis.fetch = originals.fetch;
      http.request = originals.httpRequest;
      http.get = originals.httpGet;
      https.request = originals.httpsRequest;
      https.get = originals.httpsGet;
      net.connect = originals.connect;
      net.createConnection = originals.createConnection;
      net.Socket.prototype.connect = originals.socketConnect;
      syncBuiltinESMExports();
    },
  };
}

// Settings as they would be with the gate in auto for these pilot clients (the stored settings
// refuse gate.mode 'auto' for now, so the tests pass them in).
function autoSettings(pilots) {
  const base = settingsStore.getAutomationSettings({ fresh: true });
  return { ...base, pilotClientIds: pilots, gate: { enabled: true, mode: 'auto', paused: null } };
}

function salesFileMtime() {
  const file = join(DATA_DIR, 'sales-clients.json');
  return existsSync(file) ? statSync(file).mtimeMs : 0;
}

test('the requirement tables cover exactly the vocabulary lines', () => {
  assert.deepEqual(SERVICE_REQUIREMENTS.map((row) => row.id).sort(), vocab.GATE_SERVICE_LINES.map((row) => row.id).sort());
  assert.deepEqual(PAGE_KIND_REQUIREMENTS.map((row) => row.id).sort(), vocab.GATE_PAGE_KIND_LINES.map((row) => row.id).sort());
  for (const row of [...SERVICE_REQUIREMENTS, ...PAGE_KIND_REQUIREMENTS]) {
    assert.ok(gateLib.GATE_GROUPS.includes(row.group), `${row.id} has a known group`);
    assert.ok(!row.askable || row.askText, `${row.id} has client wording`);
  }
});

test('the switch defaults to off, refuses auto and accepts shadow', () => {
  const defaults = settingsStore.defaultAutomationSettings();
  assert.deepEqual(defaults.gate, { enabled: false, mode: 'shadow', paused: null });
  assert.equal(vocab.SETTINGS_KEYS.gateEnabled, 'gate.enabled');
  assert.equal(vocab.SETTINGS_KEYS.gateMode, 'gate.mode');
  const auto = settingsStore.validateAutomationSettings({ gate: { enabled: true, mode: 'auto' } });
  assert.equal(auto.ok, false);
  assert.ok(auto.errors.some((error) => error.path === 'gate.mode'));
  const shadow = settingsStore.validateAutomationSettings({ gate: { enabled: true, mode: 'approve' } });
  assert.equal(shadow.ok, true);
  assert.equal(shadow.value.gate.mode, 'shadow');
  assert.equal(settingsStore.validateAutomationSettings({ gate: { enabled: 'yes' } }).ok, false);
  assert.equal(settingsStore.validateAutomationSettings({ gate: { paused: { reason: '' } } }).ok, false);
  // The pre-workshop lines, post-workshop and reminder defaults stay as they were.
  assert.equal(defaults.emails.preWorkshop.lines, 'legacy');
  assert.equal(defaults.emails.postWorkshop.delayMinutes, 120);
  assert.deepEqual([defaults.emails.dataReminder.afterDays, defaults.emails.dataReminder.max, defaults.emails.dataReminder.enabled], [4, 2, false]);
});

test('an empty tier-1 client has at most 8 askable dev lines', () => {
  const gate = evaluate({ id: 'empty-1', sitePlan: TIER1 });
  const dev = gateLib.askableLines(gate, { gateColumn: 'dev' });
  assert.ok(dev.rows.length <= 8, `${dev.rows.length} dev lines`);
  assert.deepEqual(dev.rows.map((row) => row.id).sort(), ['business-what', 'contact', 'logo']);
  assert.equal(gate.devComplete, false);
  assert.deepEqual(gate.missingDev.sort(), ['business-what', 'contact', 'logo', 'workshop']);
});

test('an empty client gets at most 12 mail lines, one logo line, grouped in the fixed order', () => {
  for (const plan of [TIER1, TIER2, TIER3]) {
    const gate = evaluate({ id: `empty-${plan.tierId}`, sitePlan: plan, makerRun: { runId: 'r1', materials: { runId: 'r1', pageKinds: [{ route: '/team', kind: 'team' }, { route: '/meny', kind: 'menu' }, { route: '/booking', kind: 'booking' }] } } });
    const asked = gateLib.askableLines(gate);
    assert.ok(asked.rows.length <= 12, `${plan.tierId}: ${asked.rows.length}`);
    const rowIds = asked.rows.map((row) => row.id);
    assert.equal(new Set(rowIds).size, rowIds.length, 'no duplicate line');
    assert.equal(rowIds.filter((id) => id === 'logo').length, 1, 'one logo line');
    assert.equal(ids(gate).filter((id) => id === 'booking-services').length <= 1, true);
    const order = asked.groups.map((group) => gateLib.GATE_GROUPS.indexOf(group.group));
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    assert.ok(asked.rows.every((row) => row.source === 'gate' && row.title));
  }
});

test('no product line appears without the ecom or catalog service', () => {
  for (const plan of [TIER1, TIER2]) {
    const gate = evaluate({ id: 'np', sitePlan: plan });
    assert.deepEqual(ids(gate).filter((id) => PRODUCT_LINES.includes(id)), [], plan.tierId);
  }
  const catalog = evaluate({ id: 'cat', sitePlan: { ...TIER1, tierId: 'custom', services: ['site', 'catalog'] } });
  assert.deepEqual(ids(catalog).filter((id) => PRODUCT_LINES.includes(id)), ['catalog-items']);
});

test('a tier-3 shop gets products, seller and logo lines; shipping is only a ready line', () => {
  const gate = evaluate({ id: 'shop', sitePlan: TIER3 });
  for (const id of ['products', 'seller', 'logo', 'shipping', 'returns', 'payment']) assert.ok(line(gate, id), id);
  const shipping = line(gate, 'shipping');
  assert.equal(shipping.gate, 'ready');
  assert.ok(!gate.missingDev.includes('shipping'));
  assert.ok(gate.missingReady.includes('shipping'));
  assert.equal(line(gate, 'payment').gate, 'ready');
  assert.equal(line(gate, 'payment').askable, false);
  assert.ok(gate.missingDev.includes('products') && gate.missingDev.includes('seller'));
});

test('page-kind lines follow the page plan, on any tier and without a sellable service', () => {
  const pages = (...kinds) => ({ runId: 'r1', pageKinds: kinds.map((kind, index) => ({ route: `/p${index}`, kind })) });
  const run = (materials) => ({ runId: 'r1', materials });
  const restaurant = evaluate({ id: 'r', sitePlan: TIER2, makerRun: run(pages('menu')) });
  assert.ok(line(restaurant, 'menu-items'));
  const portfolio = evaluate({ id: 'p', sitePlan: TIER2, makerRun: run(pages('portfolio', 'team')) });
  assert.ok(line(portfolio, 'project-images') && line(portfolio, 'staff'));
  const salon = evaluate({ id: 's', sitePlan: TIER1, makerRun: run(pages('booking')) });
  assert.ok(line(salon, 'booking-services'));
  assert.equal(line(salon, 'booking-services').origin, 'page-kind:booking');
  const plain = evaluate({ id: 'n', sitePlan: TIER2, makerRun: run(pages('about', 'contact')) });
  for (const id of ['menu-items', 'project-images', 'staff', 'booking-services', 'price-list', 'blog-topics', 'services-list']) {
    assert.equal(line(plain, id), undefined, id);
  }
  const siteOnly = evaluate({ id: 'o', sitePlan: { ...TIER1, tierId: 'custom', services: ['site'] }, makerRun: run(pages('menu')) });
  assert.ok(line(siteOnly, 'menu-items'));
  // Before a run exists, the offer's pages decide; then the wanted pages in Kundedata.
  assert.equal(pageKindFromLabel('Bestill time'), 'booking');
  assert.equal(pageKindFromLabel('/om-oss/team'), 'team');
  assert.equal(pageKindFromLabel('/no-no/men/customer-service'), '');
  const offer = { alternatives: [{ products: [{ includes: ['Meny med priser', 'Kontaktskjema'] }] }] };
  assert.deepEqual(pageKindsForClient({ offer }).list.map((row) => row.kind), ['menu']);
  assert.deepEqual(pageKindsForClient({ bank: { websiteCreatorQuestions: { wantedPages: 'Forside, prisliste, kontakt' } } }).list.map((row) => row.kind), ['pricing']);
});

test('evidence: brand colours are never evidence; the bank, Maker and inbox count; skips are declined', () => {
  const defaults = { brandIdentity: { colors: { primary: '#FF5B00', secondary: '#111827', accent: '#F9F9F8' }, logos: { normal: '' } } };
  const custom = { brandIdentity: { colors: { primary: '#123456', secondary: '#abcdef', accent: '#0f0f0f' }, logos: { normal: '' } } };
  assert.equal(bankColorsAreDefault(defaults), true);
  assert.equal(bankColorsAreDefault(custom), false);
  // No line reads colours: the portal defaults, custom colours and no bank at all give the same lines.
  const statuses = (bank) => evaluate({ id: 'c', sitePlan: TIER3 }, { bank }).lines.map((entry) => [entry.id, entry.status, entry.evidence]);
  assert.deepEqual(statuses(defaults), statuses({}));
  assert.deepEqual(statuses(custom), statuses({}));
  assert.equal(line(evaluate({ id: 'c', sitePlan: TIER1 }, { bank: custom }), 'logo').status, 'missing');
  assert.equal(line(evaluate({ id: 'c', sitePlan: TIER1 }, { bank: { brandIdentity: { logos: { normal: 'logo.svg' } } } }), 'logo').status, 'have');
  assert.equal(line(evaluate({ id: 'c', sitePlan: TIER1, makerRun: { runId: 'r', materials: { runId: 'r', logo: { present: true } } } }), 'logo').status, 'have');
  const inbox = [{ status: 'staged', found: ['logo'] }];
  assert.equal(line(evaluate({ id: 'c', sitePlan: TIER1 }, { inboxItems: inbox }), 'logo').status, 'have');
  // A snapshot of an earlier run never counts for the run linked now.
  assert.equal(line(evaluate({ id: 'c', sitePlan: TIER1, makerRun: { runId: 'new', materials: { runId: 'old', logo: { present: true } } } }), 'logo').status, 'missing');
  const skipped = evaluate({ id: 'c', sitePlan: TIER1 }, { bank: { assistantIntake: { logo: 'skipped' } } });
  assert.equal(line(skipped, 'logo').status, 'declined');
  assert.ok(!gateLib.askableLines(skipped).rows.some((row) => row.id === 'logo'), 'a declined line is never asked by email');
  assert.ok(skipped.missingDev.includes('logo'), 'a declined line still blocks development');
  const contact = evaluate({ id: 'c', sitePlan: TIER1, contactEmail: 'a@example.com', contactPhone: '+4700000000' });
  assert.match(line(contact, 'contact').evidence, /adresse/);
  const online = evaluate({ id: 'c', sitePlan: TIER1, contactEmail: 'a@example.com' }, { brief: { facts: { contact: { onlineOnly: true } } } });
  assert.equal(line(online, 'contact').status, 'have');
});

test('info lines: Maker QA, hard needs and a changed plan; dpa-missing only with the DPA module', () => {
  const client = {
    id: 'i',
    sitePlan: TIER1,
    makerRun: { runId: 'r', materials: { runId: 'r', at: '2026-10-01T00:00:00.000Z', step1Qa: { status: 'warn', score: 0.8 }, needs: { items: [{ id: 'legal.review', status: 'required' }, { id: 'logo', status: 'missing' }] } } },
    delivery: { events: { planChangedAt: '2026-10-05T00:00:00.000Z' } },
  };
  const gate = evaluate(client);
  assert.deepEqual(gate.info.map((info) => info.id).sort(), ['needs-hard', 'plan-changed-rerun', 'step1Qa']);
  assert.ok(!gate.info.some((info) => info.id === 'dpa-missing'));
  assert.ok(evaluate(client, { dpa: { missing: true } }).info.some((info) => info.id === 'dpa-missing'));
  assert.ok(!gate.lines.some((entry) => gate.info.some((info) => info.id === entry.id)), 'info lines are never gate lines');
});

test('the gate makes no outbound network call while gathering, evaluating and ticking', async () => {
  setGate({ gate: { enabled: true, mode: 'shadow' } });
  seed('net-1');
  const client = withPlan('net-1', TIER3);
  const spy = spyNetwork();
  try {
    const inputs = await gateLib.gatherGateInputs(client);
    evaluate(client, inputs);
    assert.equal((await gateLib.runGateStep({ mode: 'auto', now: NOW, settings: autoSettings(['net-1']) }, client)).wrote, true);
    await gateLib.runGateStep({ mode: 'auto', now: NOW }, sales.getSalesClientById('net-1'));
    await gateLib.runGateStep({ mode: 'shadow', now: NOW }, sales.getSalesClientById('net-1'));
    await gateLib.evaluateAndStoreGate('net-1', { sales, now: NOW });
  } finally {
    spy.restore();
  }
  assert.deepEqual(spy.calls, []);
  setGate({ gate: { enabled: false } });
});

test('negative control: with the gate off the tick never evaluates and writes nothing', async () => {
  setGate({ gate: { enabled: false } });
  seed('off-1');
  const client = withPlan('off-1', TIER1);
  let gathered = 0;
  const before = salesFileMtime();
  const auditDir = join(DATA_DIR, 'delivery-audit');
  const auditBefore = existsSync(auditDir) ? readdirSync(auditDir).map((name) => statSync(join(auditDir, name)).size) : [];
  const ctx = { mode: 'auto', now: NOW, gateDeps: { getProfile: () => { gathered += 1; return null; } } };
  const result = await gateLib.runGateStep(ctx, client);
  assert.equal(result.wrote, false);
  assert.equal(result.skipped, 'gate-off');
  assert.equal(gathered, 0, 'no input was read');
  assert.equal(salesFileMtime(), before);
  const auditAfter = existsSync(auditDir) ? readdirSync(auditDir).map((name) => statSync(join(auditDir, name)).size) : [];
  assert.deepEqual(auditAfter, auditBefore);
  assert.equal(sales.getSalesClientById('off-1').delivery?.gate ?? null, null);
  assert.equal(await gateLib.gateMailLinesFor(client), null);
});

test('tick with the gate and the loop in auto stores the gate with its input hash and re-evaluates only when inputs change', async () => {
  setGate({ gate: { enabled: true, mode: 'shadow' } });
  seed('tick-1');
  withPlan('tick-1', TIER1);
  let bank = {};
  const ctx = { mode: 'auto', now: NOW, settings: autoSettings(['tick-1']), gateDeps: { getProfile: () => ({ clientDataBank: bank }) } };
  // The gate in shadow (as stored now): the loop in auto still writes no client data.
  const before = salesFileMtime();
  gateLib.resetGateShadowCacheForTests();
  const shadow = await gateLib.runGateStep({ ...ctx, settings: undefined }, sales.getSalesClientById('tick-1'));
  assert.equal(shadow.shadow, true);
  assert.equal(salesFileMtime(), before, 'a gate in shadow never stores client.delivery.gate from the tick');
  assert.equal(sales.getSalesClientById('tick-1').delivery?.gate ?? null, null);
  // A client that is not a pilot stays in shadow when the gate is auto.
  assert.equal((await gateLib.runGateStep({ ...ctx, settings: autoSettings(['someone-else']) }, sales.getSalesClientById('tick-1'))).wrote, false);
  assert.equal(sales.getSalesClientById('tick-1').delivery?.gate ?? null, null);
  const first = await gateLib.runGateStep(ctx, sales.getSalesClientById('tick-1'));
  assert.equal(first.wrote, true);
  const stored = sales.getSalesClientById('tick-1').delivery.gate;
  assert.match(stored.inputHash, /^[a-f0-9]{64}$/);
  assert.equal(line(stored, 'logo').status, 'missing');
  const mtime = salesFileMtime();
  const again = await gateLib.runGateStep(ctx, sales.getSalesClientById('tick-1'));
  assert.equal(again.wrote, false, 'an unchanged tick writes nothing');
  assert.equal(salesFileMtime(), mtime);
  bank = { brandIdentity: { logos: { normal: 'logo.svg' } } };
  const changed = await gateLib.runGateStep(ctx, sales.getSalesClientById('tick-1'));
  assert.equal(changed.wrote, true);
  assert.equal(line(sales.getSalesClientById('tick-1').delivery.gate, 'logo').status, 'have');
  setGate({ gate: { enabled: false } });
});

test('tick in loop shadow writes one audit record per input hash and no client data', async () => {
  setGate({ gate: { enabled: true, mode: 'shadow' } });
  seed('shadow-1');
  withPlan('shadow-1', TIER1);
  gateLib.resetGateShadowCacheForTests();
  const ctx = { mode: 'shadow', now: NOW };
  const before = salesFileMtime();
  const first = await gateLib.runGateStep(ctx, sales.getSalesClientById('shadow-1'));
  assert.equal(first.wrote, true);
  assert.equal(first.shadow, true);
  const second = await gateLib.runGateStep(ctx, sales.getSalesClientById('shadow-1'));
  assert.equal(second.wrote, false);
  assert.equal(salesFileMtime(), before, 'shadow never writes the client');
  assert.equal(sales.getSalesClientById('shadow-1').delivery?.gate ?? null, null);
  const { readDeliveryAudit } = await import('../lib/delivery-audit.js');
  const rows = readDeliveryAudit({ dataDir: DATA_DIR, month: NOW.slice(0, 7) }).filter((row) => row.kind === 'gate-shadow' && row.clientId === 'shadow-1');
  assert.equal(rows.length, 1);
  setGate({ gate: { enabled: false } });
});

test('waivers persist across evaluations and ticks; waive-to-remove carries a directive; approval passes the gate', async () => {
  setGate({ gate: { enabled: true, mode: 'shadow' } });
  seed('waive-1', { makerRun: { runId: 'r9' } });
  withPlan('waive-1', TIER1);
  sales.setSalesMakerRunOwned('waive-1', { materials: { runId: 'r9', pageKinds: [{ route: '/team', kind: 'team' }], at: NOW, receivedAt: NOW } });
  const bad = await gateLib.setGateWaiver('waive-1', { lineId: 'staff', option: 'Not an option', sales, now: NOW });
  assert.equal(bad.ok, false);
  const waived = await gateLib.setGateWaiver('waive-1', { lineId: 'staff', option: 'Fjern teamsiden', by: 'dev:test', sales, now: NOW });
  assert.equal(waived.ok, true);
  assert.equal(line(waived.gate, 'staff').status, 'waived');
  assert.deepEqual(gateLib.gateDirectives(waived.gate).map((entry) => [entry.action, entry.pageKind]), [['remove', 'team']]);
  await gateLib.setGateWaiver('waive-1', { lineId: 'logo', option: 'Bruk tekstlogo', by: 'dev:test', sales, now: NOW });
  // A tick and an explicit evaluation keep the waivers.
  await gateLib.runGateStep({ mode: 'auto', now: NOW }, sales.getSalesClientById('waive-1'));
  await gateLib.evaluateAndStoreGate('waive-1', { sales, now: NOW });
  const stored = sales.getSalesClientById('waive-1').delivery.gate;
  assert.deepEqual(Object.keys(stored.waivers).sort(), ['logo', 'staff']);
  assert.equal(line(stored, 'logo').status, 'waived');
  assert.ok(!stored.missingDev.includes('logo'));
  assert.equal(stored.passed, false);
  const approved = await gateLib.approveGate('waive-1', { by: 'admin:test', note: 'Muntlig avtalt', sales, now: NOW });
  assert.equal(approved.gate.passed, true);
  assert.equal(approved.gate.devComplete, false);
  const { deriveStage } = await import('../lib/delivery-state.js');
  sales.setSalesWorkshop('waive-1', { heldAt: NOW });
  assert.equal(deriveStage(sales.getSalesClientById('waive-1'), { now: NOW }).stage, 'gate');
  // Removing a waiver brings the line back.
  const removed = await gateLib.setGateWaiver('waive-1', { lineId: 'logo', option: '', sales, now: NOW });
  assert.equal(line(removed.gate, 'logo').status, 'missing');
  assert.equal(removed.gate.passed, true, 'the approval stays');
  setGate({ gate: { enabled: false } });
});

test('a waiver or an approval stored while an evaluation gathers its inputs is kept', async () => {
  setGate({ gate: { enabled: true, mode: 'shadow' } });
  seed('race-1');
  withPlan('race-1', TIER1);
  // Another request stores a waiver while evaluateAndStoreGate awaits its inputs.
  const deps = {
    getProfile: () => {
      sales.setSalesDelivery('race-1', { gate: { waivers: { logo: { option: 'Bruk tekstlogo', by: 'dev:other', at: NOW } }, approvedAt: NOW, approvedBy: 'admin:other' } });
      return { clientDataBank: {} };
    },
  };
  const result = await gateLib.evaluateAndStoreGate('race-1', { sales, now: NOW, deps });
  assert.equal(result.changed, true);
  const stored = sales.getSalesClientById('race-1').delivery.gate;
  assert.equal(stored.waivers.logo?.option, 'Bruk tekstlogo', 'the waiver survives');
  assert.equal(stored.approvedAt, NOW, 'the approval survives');
  assert.equal(line(stored, 'logo').status, 'waived');
  // The same for a waiver stored while another waiver is being set.
  seed('race-2');
  withPlan('race-2', TIER1);
  const other = {
    getProfile: () => {
      sales.setSalesDelivery('race-2', { gate: { waivers: { contact: { option: 'Kun e-post/nett', by: 'dev:other', at: NOW } } } });
      return { clientDataBank: {} };
    },
  };
  const waived = await gateLib.setGateWaiver('race-2', { lineId: 'logo', option: 'Bruk tekstlogo', by: 'dev:test', sales, now: NOW, deps: other });
  assert.deepEqual(Object.keys(waived.gate.waivers).sort(), ['contact', 'logo']);
  setGate({ gate: { enabled: false } });
});

test('payment: starting a connection bumps shopConnectionRev but only a shop that can take payment flips the line on the next tick', async () => {
  setGate({ gate: { enabled: true, mode: 'shadow' } });
  assert.equal(await gateLib.installShopConnectionListener({ sales, hub }), true);
  const site = hub.createSite({ name: 'Example shop', domain: 'shop.example.com', websitePlan: 'tier-3-ecommerce' });
  seed('shop-1', { hubSite: { id: site.id, siteKey: site.site_key } });
  withPlan('shop-1', TIER3);
  const ctx = { mode: 'auto', now: NOW, hub, settings: autoSettings(['shop-1']) };
  await gateLib.runGateStep(ctx, sales.getSalesClientById('shop-1'));
  assert.equal(line(sales.getSalesClientById('shop-1').delivery.gate, 'payment').status, 'missing');
  // Connect through the real onboarding code with a stand-in Stripe SDK (no network, a local
  // test-mode key and webhook secret that exist only in this temp data dir).
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(DATA_DIR, 'shop-payments-platform.json'), JSON.stringify({ stripe: { mode: 'test', testSecretKey: 'sk_test_standin', webhooks: { test: { secret: 'whsec_standin' } } } }));
  shop.setShopPaymentDeps({
    stripeFactory: () => ({
      accounts: { create: async () => ({ id: 'acct_standin', charges_enabled: false }), retrieve: async () => ({ id: 'acct_standin' }) },
      accountLinks: { create: async () => ({ url: 'https://connect.example.com/onboarding' }) },
      webhooks: { constructEvent: (raw) => JSON.parse(String(raw)) },
    }),
    fetch: async () => { throw new Error('no network'); },
  });
  const before = hub.getSiteById(site.id).shopConnectionRev || 0;
  await shop.startStripeOnboarding(hub.getSiteById(site.id), { returnUrl: 'http://127.0.0.1/admin', hubUrl: 'http://127.0.0.1:3001' });
  assert.equal(hub.getSiteById(site.id).shopConnectionRev, before + 1);
  assert.equal(shop.readStoredShopConnections(site.id).stripe.connected, true);
  assert.equal(shop.readStoredShopConnections(site.id).stripe.ready, false, 'onboarding started, charges not enabled');
  assert.ok(sales.getSalesClientById('shop-1').delivery.dirtyAt, 'the client is marked for a gate check');
  await gateLib.runGateStep(ctx, sales.getSalesClientById('shop-1'));
  const started = sales.getSalesClientById('shop-1').delivery.gate;
  assert.equal(line(started, 'payment').status, 'missing', 'a shop that cannot take payment is still missing');
  assert.match(line(started, 'payment').evidence, /kan ikke ta imot betaling/);
  assert.equal(started.inputs.shopConnectionRev, before + 1);
  // Stripe reports the account can take charges (account.updated): the next tick flips the line.
  const event = { type: 'account.updated', account: 'acct_standin', data: { object: { id: 'acct_standin', charges_enabled: true, details_submitted: true } } };
  assert.equal(shop.parseStripeConnectWebhook(JSON.stringify(event), 'stand-in-signature').siteId, site.id);
  assert.equal(hub.getSiteById(site.id).shopConnectionRev, before + 2);
  assert.equal(shop.readStoredShopConnections(site.id).stripe.ready, true);
  await gateLib.runGateStep(ctx, sales.getSalesClientById('shop-1'));
  assert.equal(line(sales.getSalesClientById('shop-1').delivery.gate, 'payment').status, 'have');
  assert.equal(sales.getSalesClientById('shop-1').delivery.gate.inputs.shopConnectionRev, before + 2);
  // PayPal follows the same rule: a login payee counts only once payments are receivable.
  const paypal = (row) => gateLib.evaluateDeliveryGate({ id: 'p', sitePlan: TIER3 }, { shopConnections: row }, { now: NOW });
  assert.equal(line(paypal({ paypal: { connected: true, paymentsReceivable: false, ready: false } }), 'payment').status, 'missing');
  assert.equal(line(paypal({ paypal: { connected: true, paymentsReceivable: true, ready: true } }), 'payment').status, 'have');
  // With the gate off, a connection write bumps nothing.
  setGate({ gate: { enabled: false } });
  shop.disconnectProvider(hub.getSiteById(site.id), 'stripe');
  assert.equal(hub.getSiteById(site.id).shopConnectionRev, before + 2);
  shop.setShopPaymentDeps({});
});

test('gate-f1 exits non-zero when it has nothing to score', () => {
  const script = join(root, 'scripts', 'eval', 'gate-f1.mjs');
  const empty = mkdtempSync(join(tmpdir(), 'asoldi-gate-f1-empty-'));
  const run = (dir) => {
    try {
      execFileSync(process.execPath, [script, dir], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { status: 0, stderr: '' };
    } catch (error) {
      return { status: error.status, stderr: String(error.stderr || '') };
    }
  };
  const emptyRun = run(empty);
  assert.equal(emptyRun.status, 1);
  assert.match(emptyRun.stderr, /no client was scored/);
  assert.equal(run(join(empty, 'not-there')).status, 1);
  // A label without a gate to score.
  mkdirSync(join(empty, 'syn-only-label'));
  writeFileSync(join(empty, 'syn-only-label', 'gate-expected.json'), JSON.stringify({ lines: [] }));
  const unscored = run(empty);
  assert.equal(unscored.status, 1);
  assert.match(unscored.stderr, /no gate to score for: syn-only-label/);
  assert.equal(run(join(root, 'scripts', 'fixtures', 'gate-labels')).status, 0, 'the synthetic labels pass');
});

test('gate-f1 scores at least 0.9 on the synthetic labels, and a wrong gate scores lower', async () => {
  const dir = join(root, 'scripts', 'fixtures', 'gate-labels');
  const result = await gateF1(dir);
  assert.ok(result.clients.length >= 5, 'five synthetic clients');
  assert.ok(result.clients.every((client) => client.source === 'evaluated'));
  assert.ok(result.overall.f1 >= 0.9, `F1 ${result.overall.f1}`);
  const { scoreClient, summarize } = await import('./eval/gate-f1.mjs');
  const expected = { lines: [{ id: 'logo', status: 'missing' }, { id: 'contact', status: 'have' }] };
  const wrong = summarize(scoreClient(expected, { lines: [{ id: 'logo', status: 'have' }, { id: 'contact', status: 'have' }, { id: 'products', status: 'missing' }] }));
  assert.ok(wrong.overall.f1 < 0.9);
  assert.equal(wrong.perLine.contact.f1, 1);
});

test('the labels hold line ids and statuses only (no names, addresses or numbers)', async () => {
  const dir = join(root, 'scripts', 'fixtures', 'gate-labels');
  const { readFileSync } = await import('node:fs');
  for (const id of readdirSync(dir)) {
    const expected = readFileSync(join(dir, id, 'gate-expected.json'), 'utf8');
    for (const lineEntry of JSON.parse(expected).lines) assert.ok(vocab.isGateLineId(lineEntry.id), lineEntry.id);
    const input = readFileSync(join(dir, id, 'gate-input.json'), 'utf8');
    assert.ok(id.startsWith('syn-'), 'synthetic clients only');
    for (const match of input.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) || []) assert.match(match, /@example\.com$/);
    assert.doesNotMatch(input, /\+47 [1-9]/, 'only reserved numbers');
  }
});

test('on the real hub: gate routes answer 404 disabled while off, the desk route keeps its answer, and nothing is written', { timeout: 240_000 }, async (t) => {
  const { bootHub } = await import('./safe-mode/hub-boot.mjs');
  const { writeFileSync, readFileSync } = await import('node:fs');
  const admin = 'gate-boot-admin';
  const password = `gate-boot-${Date.now()}-pw`;
  const clients = [{ id: 'gate-boot-1', product: 'asoldi', businessName: 'Example Boot AS', status: 'active', contactEmail: 'boot@example.com', progression: { meetingHeld: true, offerSent: true, contractSigned: true } }];
  const hubBoot = await bootHub({ HUB_SAFE_MODE: '1', PERSIST_PRODUCTION_ENV: '0', ADMIN_USERNAME: admin, ADMIN_PASSWORD: password, DATA_DIR: '' }, {
    seed: (dir) => writeFileSync(join(dir, 'sales-clients.json'), JSON.stringify(clients, null, 2)),
  });
  t.after(() => hubBoot.stop());
  assert.ok(hubBoot.health, `hub did not start:\n${hubBoot.log().slice(-3000)}`);
  const token = await hubBoot.adminToken(admin, password);
  assert.ok(token, 'admin token');
  const call = (method, path, body) => fetch(`${hubBoot.base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const storesBefore = readFileSync(join(hubBoot.dataDir, 'sales-clients.json'), 'utf8');
  for (const [method, path] of [['GET', '/api/admin/delivery/gate'], ['GET', '/api/admin/delivery/gate/gate-boot-1'], ['POST', '/api/admin/sales/gate-boot-1/workshop/held']]) {
    const res = await call(method, path, method === 'POST' ? {} : undefined);
    assert.equal(res.status, 404, path);
    assert.equal((await res.json()).code, 'disabled', path);
  }
  const desk = await call('POST', '/api/admin/sales/gate-boot-1/workshop/desk-email', { kind: 'post-workshop' });
  assert.equal(desk.status, 400, 'the existing desk route answers an unknown kind as before');
  assert.equal((await desk.json()).message, 'Ukjent e-postmal.');
  assert.equal(readFileSync(join(hubBoot.dataDir, 'sales-clients.json'), 'utf8'), storesBefore, 'no client write');
  assert.equal(existsSync(join(hubBoot.dataDir, 'delivery-audit')), false, 'no delivery write');
  assert.equal(existsSync(join(hubBoot.dataDir, 'delivery-email-shadow.json')), false);
  // Switched on: the developer view answers.
  const put = await call('PUT', '/api/admin/automation-settings', { gate: { enabled: true } });
  assert.equal(put.status, 200);
  const list = await call('GET', '/api/admin/delivery/gate');
  assert.equal(list.status, 200);
  assert.ok((await list.json()).clients.some((client) => client.clientId === 'gate-boot-1'));
  const view = await call('GET', '/api/admin/delivery/gate/gate-boot-1');
  assert.equal(view.status, 200);
  assert.ok((await view.json()).gate.lines.some((line) => line.id === 'logo'));
});
