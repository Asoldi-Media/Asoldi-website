// The signer's optional hooks and stamps, in process with the safe-mode outbox: gate lines in the
// pre-workshop mail when emails.preWorkshop.lines is 'gate' (and only then), the agreed-keyword freeze,
// and the accepted alternative's DPA version on client.ext.dpa.offerVersion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-signing-hooks-'));
process.env.APP_DATA_DIR = DATA_DIR;
test.after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

const T = '2026-10-21T09:00:00.000Z';
const { buildOfferFromMeetingQuote } = await import('../lib/offer-from-quote.js');
const built = buildOfferFromMeetingQuote({ tierId: 'seo', selected: [], pages: 7 });
const offer = (id, salesClientId, extra = {}) => ({
  id, salesClientId, status: 'sent', tierId: built.tierId, billing: 'month', products: built.products,
  alternatives: built.alternatives.map((alternative) => ({ ...alternative, ...extra })), plan: built.plan, pricing: built.pricing,
  email: { subject: 'Tilbud', preheader: '', html: '<p>Tilbud</p>' }, sentAt: T, createdAt: T, updatedAt: T, ...extra,
});
const client = (id) => ({ id, product: 'asoldi', status: 'active', businessName: `${id} Example AS`, contactPerson: 'Kari Example', contactEmail: `${id}@example.com`, progression: { meetingHeld: true, offerSent: true }, createdAt: T, updatedAt: T });
writeFileSync(join(DATA_DIR, 'sales-clients.json'), JSON.stringify([client('gate'), client('legacy')], null, 2));
writeFileSync(join(DATA_DIR, 'sales-offers.json'), JSON.stringify([offer('o-gate', 'gate', { dpaVersion: 'dpa-test-1' }), offer('o-legacy', 'legacy')], null, 2));

const { installSafeMode, resetSafeModeForTests } = await import('../lib/safe-mode.js');
installSafeMode({ env: { HUB_SAFE_MODE: '1' }, dataDir: DATA_DIR, log: null, egress: false });
test.after(() => resetSafeModeForTests());
const settingsStore = await import('../data/automation-settings.js');
// Auto needs a recorded release pass (lib/spine-mode.js); settings in auto hold the passes.
const { testReleases } = await import('./fixtures/test-releases.mjs');
const sales = await import('../data/sales.js');
const signing = await import('../lib/contract-signing.js');

function setLines(lines) {
  writeFileSync(join(DATA_DIR, 'automation-settings.json'), JSON.stringify({
    pilotClientIds: ['gate', 'legacy'],
    releases: testReleases(),
    signing: { enabled: true, mode: 'auto', paused: null },
    emails: { preWorkshop: { enabled: true, mode: 'auto', paused: null, lines } },
  }));
  settingsStore.invalidateAutomationSettingsCache();
}

function mailTextTo(address) {
  const index = join(DATA_DIR, 'outbox', 'index.jsonl');
  if (!existsSync(index)) return [];
  const rows = readFileSync(index, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((row) => (row.to || []).includes(address));
  return rows.map((row) => {
    const day = readdirSync(join(DATA_DIR, 'outbox')).find((name) => existsSync(join(DATA_DIR, 'outbox', name, `${row.id}.body.json`)));
    return JSON.parse(readFileSync(join(DATA_DIR, 'outbox', day, `${row.id}.body.json`), 'utf8')).text;
  });
}

test('gate lines go into the pre-workshop mail when the setting says gate; the keyword freeze runs; the DPA version is copied', async () => {
  setLines('gate');
  const asked = [];
  const frozen = [];
  const result = await signing.markContractSigned('gate', {
    source: 'progression',
    actor: 'test',
    hooks: {
      askableLines: (current) => {
        asked.push(current.id);
        return [{ title: 'Gate line one', detail: 'from the gate' }, { title: 'Gate line two' }];
      },
      freezeAgreedKeywords: (clientId, meta) => frozen.push([clientId, meta.reason]),
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.mailed, true);
  assert.deepEqual(asked, ['gate']);
  assert.deepEqual(frozen, [['gate', 'contract-signed']]);
  const texts = mailTextTo('gate@example.com');
  assert.equal(texts.length, 1);
  assert.match(texts[0], /- Gate line one: from the gate/);
  assert.match(texts[0], /- Gate line two/);
  const stored = sales.getSalesClientById('gate');
  assert.equal(stored.ext?.dpa?.offerVersion, 'dpa-test-1');
  assert.equal(stored.sitePlan.dpaVersion, 'dpa-test-1');
  assert.equal(stored.delivery.stage, 'gathering');
});

test('control: with legacy lines the gate is not asked and the mail keeps the old lines', async () => {
  setLines('legacy');
  let asked = 0;
  const result = await signing.markContractSigned('legacy', {
    source: 'progression',
    actor: 'test',
    hooks: { askableLines: () => { asked += 1; return [{ title: 'Gate line one' }]; } },
  });
  assert.equal(result.ok, true);
  assert.equal(asked, 0);
  const texts = mailTextTo('legacy@example.com');
  assert.equal(texts.length, 1);
  assert.doesNotMatch(texts[0], /Gate line one/);
  assert.equal(sales.getSalesClientById('legacy').ext?.dpa, undefined, 'no DPA version on the offer, nothing copied');
});

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the signing lease is renewed while a slow signing runs, so a second process waits; control: an unrenewed lease runs out', async () => {
  let second = 'not tried';
  const result = await signing.withSigningLease('slow-client', async (held) => {
    await pause(600);
    second = await signing.takeSigningLease('slow-client', { waitMs: 0, leaseMs: 150 });
    assert.equal(held.lost, false);
    return 'done';
  }, { leaseMs: 150 });
  assert.equal(result, 'done');
  assert.equal(second, null, 'still held after four lease times');
  const after = await signing.takeSigningLease('slow-client', { waitMs: 0, leaseMs: 150 });
  assert.ok(after, 'released at the end');
  await after.release();
  const { acquireLease } = await import('../data/email-store.js');
  const plain = await acquireLease('sign:slow-control', 150);
  assert.ok(plain);
  await pause(600);
  const other = await acquireLease('sign:slow-control', 150);
  assert.ok(other, 'control: without renewal a second taker gets the lease');
  await other.release();
});

test('the shadow record never throws into the path around it', async () => {
  const note = { get broken() { throw new Error('note getter failed'); } };
  const result = await signing.recordSigningShadow('legacy', { source: 'progression', note });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'error');
});
