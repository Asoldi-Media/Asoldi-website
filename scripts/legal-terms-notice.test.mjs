// The terms-update notice: a staff action sends emails.termsUpdate. Shadow writes one outbox draft
// and records nothing. Auto sends once, records the notice, and refuses a second send. The kind
// cannot be set to auto until a release pass is recorded. The route is closed while the legal
// switch is off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'legal-terms-notice-'));
process.env.APP_DATA_DIR = dataDir;
process.env.DATA_DIR = '';

const express = (await import('express')).default;
const sales = await import('../data/sales.js');
const settingsStore = await import('../data/automation-settings.js');
const { register } = await import('../lib/routes/legal-routes.js');
const { readDeliveryAudit } = await import('../lib/delivery-audit.js');
const { CATALOG_VERSION } = await import('../lib/legal/catalog.js');

const sent = [];
let failSend = false;
let server = null;
let base = '';

function setSwitch(enabled) {
  const patch = { legal: { catalogTexts: { enabled } } };
  if (enabled) patch.retention = { analyticsTraffic: { enabled: true, mode: 'auto' } };
  const result = settingsStore.saveAutomationSettings(patch, { by: 'test', reason: 'test' });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
}

function signedLegacy(name) {
  const slug = name.toLowerCase().replace(/\s+/g, '');
  const client = sales.createSalesClient({
    businessName: name,
    contactEmail: `${slug}@example.com`,
    contactPerson: 'Kari',
    product: 'asoldi',
  });
  return sales.setSalesProgress(client.id, 'contractSigned', true, { fastTrack: true });
}

test.before(async () => {
  const app = express();
  app.use(express.json());
  await register(app, {
    dataDir,
    adminAuth: (req, res, next) => (req.get('x-test-admin') === '1' ? next() : res.status(401).json({ message: 'Unauthorized' })),
    clientAuth: (_req, res) => res.status(401).json({ message: 'Unauthorized' }),
    sales,
    salesOffers: { listSalesOffers: () => [] },
    sendEmail: async (message) => {
      if (failSend) throw new Error('smtp down');
      sent.push(message);
    },
  });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

async function call(path, { method = 'GET', admin = false } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (admin) headers['x-test-admin'] = '1';
  const res = await fetch(`${base}${path}`, { method, headers, ...(method === 'POST' ? { body: '{}' } : {}) });
  return { status: res.status, body: await res.json() };
}

function outbox() {
  const file = join(dataDir, 'outbox', 'index.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('emails.termsUpdate starts switched off in shadow mode', () => {
  const fresh = settingsStore.defaultAutomationSettings().emails.termsUpdate;
  assert.deepEqual(fresh, { enabled: false, mode: 'shadow', paused: null });
});

test('emails.termsUpdate cannot be set to auto without a recorded release pass', () => {
  const refused = settingsStore.saveAutomationSettings({ emails: { termsUpdate: { enabled: true, mode: 'auto' } } }, { by: 'test', reason: 'test' });
  assert.equal(refused.ok, false);
  assert.ok(refused.errors.some((error) => error.path === 'emails.termsUpdate'));
  assert.equal(settingsStore.getAutomationSettings({ fresh: true }).emails.termsUpdate.mode, 'shadow');
});

test('the terms-update list still sends nothing and writes no outbox', async () => {
  setSwitch(true);
  signedLegacy('Liste Bakeri AS');
  const listed = await call('/api/admin/legal/terms-update', { admin: true });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.sends, false);
  assert.ok(listed.body.clients.length >= 1);
  assert.deepEqual(outbox(), []);
});

test('shadow writes one delivery-shadow outbox draft and records no notice', async () => {
  setSwitch(true);
  const saved = settingsStore.saveAutomationSettings({
    emails: { termsUpdate: { enabled: true, mode: 'shadow' } },
  }, { by: 'test', reason: 'test' });
  assert.equal(saved.ok, true, JSON.stringify(saved.errors));
  const client = signedLegacy('Skygge Bakeri AS');
  const before = sent.length;
  const res = await call(`/api/admin/legal/terms-update/${client.id}/send`, { method: 'POST', admin: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { ok: true, mode: 'shadow', recorded: false });
  const rows = outbox();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel, 'delivery-shadow');
  assert.match(rows[0].from, /damian@asoldi.com/);
  assert.equal(rows[0].replyTo, 'alexander@asoldi.com');
  assert.equal(sales.getSalesClientById(client.id).ext?.legal?.notice, undefined);
  assert.equal(sent.length, before, 'shadow does not call the transport');
});

test('paused writes nothing', async () => {
  setSwitch(true);
  const client = signedLegacy('Pause Bakeri AS');
  const paused = settingsStore.saveAutomationSettings({
    emails: { termsUpdate: { paused: { reason: 'test' } } },
  }, { by: 'test', reason: 'test' });
  assert.equal(paused.ok, true, JSON.stringify(paused.errors));
  const before = outbox().length;
  const res = await call(`/api/admin/legal/terms-update/${client.id}/send`, { method: 'POST', admin: true });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'paused');
  assert.equal(outbox().length, before);
  assert.equal(sales.getSalesClientById(client.id).ext?.legal?.notice, undefined);
  const resumed = settingsStore.saveAutomationSettings({ emails: { termsUpdate: { paused: null } } }, { by: 'test', reason: 'test' });
  assert.equal(resumed.ok, true, JSON.stringify(resumed.errors));
});

test('auto sends once, records the notice, and a second send is refused', async () => {
  setSwitch(true);
  const client = signedLegacy('Auto Bakeri AS');
  const listed = settingsStore.saveAutomationSettings({
    legal: { catalogTexts: { enabled: true } },
    retention: { analyticsTraffic: { enabled: true, mode: 'auto' } },
    pilotClientIds: [client.id],
  }, { by: 'test', reason: 'test' });
  assert.equal(listed.ok, true, JSON.stringify(listed.errors));
  const passed = settingsStore.recordReleasePass('emails.termsUpdate', { suite: 'notice-test', by: 'test' });
  assert.equal(passed.ok, true, passed.error);
  assert.equal(passed.settings.emails.termsUpdate.mode, 'auto');
  const before = sent.length;
  const first = await call(`/api/admin/legal/terms-update/${client.id}/send`, { method: 'POST', admin: true });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body, { ok: true, mode: 'auto', recorded: true });
  assert.equal(sent.length, before + 1);
  assert.match(sent.at(-1).from, /damian@asoldi.com/);
  assert.equal(sent.at(-1).replyTo, 'alexander@asoldi.com');
  assert.equal(sent.at(-1).to, client.contactEmail);
  const notice = sales.getSalesClientById(client.id).ext.legal.notice;
  assert.equal(notice.catalogVersion, CATALOG_VERSION);
  assert.ok(notice.sentAt);
  assert.match(notice.effectiveFrom, /^\d{4}-\d{2}-\d{2}$/);
  const audit = readDeliveryAudit({ dataDir }).filter((row) => row.kind === 'email-sent' && row.email === 'termsUpdate' && row.clientId === client.id);
  assert.equal(audit.length, 1);
  const second = await call(`/api/admin/legal/terms-update/${client.id}/send`, { method: 'POST', admin: true });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'no-update');
  assert.equal(sent.length, before + 1, 'the second call does not send');
});

test('a transport that throws answers 502 send-failed and records nothing; a missing recipient is told apart', async () => {
  setSwitch(true);
  const failing = signedLegacy('Feil Bakeri AS');
  const noMail = sales.createSalesClient({ businessName: 'Tom Bakeri AS', contactEmail: '', contactPerson: 'Kari', product: 'asoldi' });
  sales.setSalesProgress(noMail.id, 'contractSigned', true, { fastTrack: true });
  const listed = settingsStore.saveAutomationSettings({ pilotClientIds: [failing.id, noMail.id] }, { by: 'test', reason: 'test' });
  assert.equal(listed.ok, true, JSON.stringify(listed.errors));
  failSend = true;
  try {
    const failed = await call(`/api/admin/legal/terms-update/${failing.id}/send`, { method: 'POST', admin: true });
    assert.equal(failed.status, 502);
    assert.deepEqual(failed.body, { code: 'send-failed' });
    assert.equal(sales.getSalesClientById(failing.id).ext?.legal?.notice, undefined);
  } finally {
    failSend = false;
  }
  const empty = await call(`/api/admin/legal/terms-update/${noMail.id}/send`, { method: 'POST', admin: true });
  assert.equal(empty.status, 409);
  assert.equal(empty.body.code, 'no-recipient');
});

test('the send route answers 401 without admin credentials while the legal switch is on', async () => {
  setSwitch(true);
  const res = await call('/api/admin/legal/terms-update/anyone/send', { method: 'POST' });
  assert.equal(res.status, 401);
});

test('the send route answers 404 disabled while the legal switch is off', async () => {
  setSwitch(false);
  const res = await call('/api/admin/legal/terms-update/anyone/send', { method: 'POST', admin: true });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { code: 'disabled' });
});
