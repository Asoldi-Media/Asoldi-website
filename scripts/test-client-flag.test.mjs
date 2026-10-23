// WS8.56: a test client never shows up in Myphoner payloads, sales reports or reported numbers,
// and takes part in delivery automation only as a listed pilot. One fixture per consumer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-test-client-flag-'));
process.env.APP_DATA_DIR = DATA_DIR;
for (const key of ['MYPHONER_API_KEY', 'MYPHONER_PERSONAL_API_KEY', 'MYPHONER_SUBDOMAIN', 'WORKSHOP_DESK_EMAIL_AUTOSEND']) delete process.env[key];
// No mail transport in this test: nothing can be sent even if a check were missing.
for (const key of Object.keys(process.env)) if (/^(SMTP|RESEND)/i.test(key)) delete process.env[key];

const realClient = { id: 'real-1', product: 'asoldi', businessName: 'Real AS', status: 'active', myphoner: { leadId: 'L-real' } };
const testClient = {
  id: 'test-1', product: 'asoldi', businessName: 'Canary (test)', status: 'active', isTest: true,
  myphoner: { leadId: 'L-test', leadIds: ['L-test', 'L-test-old'] },
};
writeFileSync(join(DATA_DIR, 'sales-clients.json'), JSON.stringify([realClient, testClient], null, 2));
const offer = (id, salesClientId, status) => ({
  id, salesClientId, status, products: [{ id: `p-${id}`, kind: 'custom', name: 'Nettside', priceExMva: 1500 }],
});
writeFileSync(join(DATA_DIR, 'sales-offers.json'), JSON.stringify([
  offer('o-real-sent', 'real-1', 'sent'),
  offer('o-real-draft', 'real-1', 'draft'),
  offer('o-test-sent', 'test-1', 'sent'),
  offer('o-test-verified', 'test-1', 'verified'),
], null, 2));

const testClients = await import('../lib/test-clients.js');
const sales = await import('../data/sales.js');
const salesOffers = await import('../data/sales-offers.js');
const ssuWins = await import('../lib/myphoner-ssu-wins.js');
const settingsStore = await import('../data/automation-settings.js');
const deskEmails = await import('../lib/workshop-desk-emails.js');
const prepSend = await import('../lib/workshop-prep-send.js');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('helpers: reportable lists, id sets and record filters leave test clients and test sites out', () => {
  const clients = sales.getSalesClients();
  assert.deepEqual(testClients.reportableClients(clients).map((client) => client.id), ['real-1']);
  assert.deepEqual([...testClients.testClientIdSet(clients)], ['test-1']);
  assert.deepEqual([...testClients.testClientMyphonerLeadIds(clients)].sort(), ['L-test', 'L-test-old']);
  assert.deepEqual(
    testClients.withoutTestClientRecords([{ salesClientId: 'real-1' }, { salesClientId: 'test-1' }], clients),
    [{ salesClientId: 'real-1' }],
  );
  const sites = [{ id: 's1' }, { id: 's2', isTest: true }];
  assert.deepEqual(testClients.reportableSites(sites).map((site) => site.id), ['s1']);
  assert.equal(testClients.isTestClient({ isTest: 'true' }), false, 'only a real boolean counts');
});

test('sales report: offer counts per status leave out test clients', () => {
  assert.deepEqual(salesOffers.countOffersByStatus(), { draft: 1, 'review-requested': 0, verified: 1, sent: 2 });
  const counts = salesOffers.countOffersByStatus({ excludeSalesClientIds: testClients.testClientIdSet(sales.getSalesClients()) });
  assert.deepEqual(counts, { draft: 1, 'review-requested': 0, verified: 0, sent: 1 });
  const server = readFileSync(join(root, 'server.js'), 'utf8');
  assert.match(server, /countOffersByStatus\(\{ excludeSalesClientIds: testClientIdSet\(sales\.getSalesClients\(\)\) \}\)/, 'the offers board counts without test clients');
});

test('Myphoner push: a test client lead is never copied (no request is made)', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    throw new Error('no network in tests');
  };
  try {
    for (const id of ['L-test', 'L-test-old']) {
      const result = await ssuWins.copySsuWinnerToWinsList({ id }, { force: true, ignoreSourceList: true, assumeWinner: true });
      assert.deepEqual(result, { ok: true, skipped: 'test-client', leadId: id });
    }
    const wrapped = await ssuWins.copySsuWinnerToWinsList({ lead: { id: 'L-test' } }, { force: true });
    assert.equal(wrapped.skipped, 'test-client');
    // A real client's lead goes on (here it stops only because Myphoner is not configured).
    const real = await ssuWins.copySsuWinnerToWinsList({ id: 'L-real' }, { force: true, ignoreSourceList: true, assumeWinner: true });
    assert.notEqual(real.skipped, 'test-client');
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Myphoner patch: an incoming lead event never rewrites a test client', () => {
  assert.equal(testClients.myphonerSyncSkipReason(sales.getSalesClientById('test-1')), 'test-client');
  assert.equal(testClients.myphonerSyncSkipReason(sales.getSalesClientById('real-1')), '');
  assert.equal(testClients.myphonerSyncSkipReason(null), '');
  const server = readFileSync(join(root, 'server.js'), 'utf8');
  const start = server.indexOf('async function upsertSalesClientFromMyphonerLead(');
  const body = server.slice(start, server.indexOf('\n}\n', start));
  const guard = body.indexOf('if (myphonerSyncSkipReason(existing))');
  assert.ok(guard > 0, 'upsertSalesClientFromMyphonerLead checks the test flag');
  assert.ok(guard < body.indexOf('sales.updateSalesClient('), 'before any write');
});

test('delivery automation: a test client takes part only when listed as a pilot', () => {
  const settings = settingsStore.defaultAutomationSettings();
  const client = sales.getSalesClientById('test-1');
  assert.equal(settingsStore.automationScopeForClient(client, { settings }).included, false);
  assert.equal(settingsStore.effectiveModeForClient('emails.preWorkshop', client, { settings }), 'off');
  const piloted = { ...settings, pilotClientIds: ['test-1'] };
  assert.equal(settingsStore.automationScopeForClient(client, { settings: piloted }).included, true);
  assert.equal(settingsStore.effectiveModeForClient('emails.preWorkshop', client, { settings: piloted }), 'auto');
});

test('Myphoner winner: a test client matched without a lead id stops the winner flow before any Myphoner write', () => {
  // findSalesClientForMyphonerLead also matches by email, phone or name, so the lead-id lookup in
  // copySsuWinnerToWinsList would miss such a client. The winner flow must stop right after upsert.
  const server = readFileSync(join(root, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = server.indexOf('async function processMyphonerWinnerFromResource(');
  assert.ok(start > 0);
  const end = server.indexOf('\n}\n', start);
  assert.ok(end > start);
  const body = server.slice(start, end);
  const upsert = body.indexOf('await upsertSalesClientFromMyphonerLead(');
  const stop = body.indexOf("if (upserted.skipped === 'test-client') return");
  assert.ok(upsert > 0 && stop > upsert, 'the flow checks upserted.skipped right after upsert');
  for (const later of ['attachCachedOrPendingRecordingToClient(', 'enqueuePendingRecording(', 'copySsuWinnerToWinsList(']) {
    const at = body.indexOf(later);
    assert.ok(at > stop, `${later} runs only after the test-client stop`);
  }
});

test('Myphoner recordings: an incoming call recording is never written onto a test client', () => {
  const server = readFileSync(join(root, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = server.indexOf('async function ingestMyphonerCallRecording(');
  const end = server.indexOf('\n}\n', start);
  assert.ok(start > 0 && end > start);
  const body = server.slice(start, end);
  const found = body.indexOf('findSalesClientForRecordingMeta(');
  const guard = body.indexOf('if (myphonerSyncSkipReason(targetClient)) return');
  const write = body.indexOf('applyRecordingMetaToSalesClient(');
  assert.ok(found > 0 && guard > found && write > guard, 'the test-client check sits between the match and the write');
});

test('workshop reminders: the loop mails only active clients in automation scope (test clients only as pilots)', () => {
  const server = readFileSync(join(root, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = server.indexOf('async function sendDueWorkshopDeskEmails(');
  const end = server.indexOf('\n}\n', start);
  assert.ok(start > 0 && end > start);
  const body = server.slice(start, end);
  assert.match(body, /for \(const client of workshopReminderClients\(sales\.getSalesClients\(\)\)\)/);
  assert.doesNotMatch(body, /for \(const client of sales\.getSalesClients\(\)\)/, 'no loop over every client');

  const on = { ...settingsStore.defaultAutomationSettings() };
  on.emails = { ...on.emails, workshopReminders: { ...on.emails.workshopReminders, enabled: true } };
  const clients = sales.getSalesClients();
  assert.deepEqual(deskEmails.workshopReminderClients(clients, { settings: on }).map((client) => client.id), ['real-1']);
  const piloted = { ...on, pilotClientIds: ['test-1'] };
  assert.deepEqual(deskEmails.workshopReminderClients(clients, { settings: piloted }).map((client) => client.id).sort(), ['real-1', 'test-1']);
});

test('pre-workshop autosend on signing: a test client that is not a pilot gets nothing', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    throw new Error('no network in tests');
  };
  const deps = { fetchMakerRun: async () => null, listMail: async () => ({ messages: [] }) };
  const signed = (client) => ({ ...client, contactEmail: 'kunde@example.com', progression: { contractSigned: true } });
  try {
    const skipped = await prepSend.sendPreWorkshopAfterContractSigned(signed(sales.getSalesClientById('test-1')), deps);
    assert.equal(skipped.sent, false);
    assert.equal(skipped.reason, 'automation-off');
    assert.match(skipped.warning, /testkunde/);
    // The real client passes the automation check (it stops later only because mail is not configured here).
    const real = await prepSend.sendPreWorkshopAfterContractSigned(signed(sales.getSalesClientById('real-1')), deps);
    assert.notEqual(real.reason, 'automation-off');
    assert.equal(real.sent, false);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
