// Compliance sign-off: who may record it, what is stored, and what the Maker reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-seo-sign-'));
process.env.APP_DATA_DIR = dataDir;
process.env.HUB_SAFE_MODE = '1';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/contracts/plan-compliance.json', import.meta.url), 'utf8'));
const routes = await import('../lib/routes/seo-record-routes.js');
const record = await import('../lib/seo-ops/record.js');
const settingsStore = await import('../data/automation-settings.js');

const clients = new Map();
function addClient(id, fields) {
  clients.set(id, { id, ...fields });
  return clients.get(id);
}

addClient('syn-own', { developerOwnerId: 'developer:201' });
addClient('syn-handoff', {
  developerOwnerId: 'developer:202',
  developerHandoff: { status: 'waiting-upload', fromOwnerId: 'developer:201', toOwnerId: 'developer:202' },
});
addClient('syn-hidden', { developerOwnerId: 'developer:201' });

let nowIso = '2026-12-03T10:00:00.000Z';
record.setSeoRecordStoreForTests({ now: () => new Date(nowIso) });

function staffAuth(req, res, next) {
  const role = req.get('x-test-role') || '';
  if (!role) return res.status(401).json({ message: 'Unauthorized' });
  if (role === 'sales') {
    req.salesUser = { role: 'sales', isAdmin: false, username: 'rep-a', userId: '101' };
    return next();
  }
  if (role === 'admin') {
    req.developmentUser = { role: 'admin', isAdmin: true, username: 'admin', accountKey: 'admin' };
    req.salesUser = { role: 'admin', isAdmin: true, username: 'admin' };
    return next();
  }
  if (role === 'developer') {
    const userId = req.get('x-test-user') || '201';
    req.developmentUser = { role: 'developer', isAdmin: false, username: 'dev-one', userId, accountKey: `developer:${userId}` };
    return next();
  }
  return res.status(401).json({ message: 'Unauthorized' });
}

const makerAuth = {
  requireMakerHost() {
    return (req, res, next) => (req.get('x-maker-host-token') === 'maker-token' ? next() : res.status(401).json({ message: 'Unauthorized' }));
  },
};

function buildApp() {
  const app = express();
  app.use(express.json());
  routes.register(app, {
    salesOrDevelopmentAuth: staffAuth,
    developmentAuth: staffAuth,
    makerAuth,
    sales: { getSalesClientById: (id) => clients.get(id) || null },
    getDataDir: () => dataDir,
  });
  return app;
}

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function call(base, method, path, { headers = {}, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: response.status, json, text };
}

function recordPath(id) {
  return join(dataDir, 'seo-ops', 'clients', `${id}.json`);
}

function snap(id) {
  return existsSync(recordPath(id)) ? readFileSync(recordPath(id)) : null;
}

function headersFor(caller) {
  if (caller === 'admin' || caller.startsWith('admin')) return { 'x-test-role': 'admin' };
  if (caller.startsWith('developer')) {
    if (caller.includes('cannot see')) return { 'x-test-role': 'developer', 'x-test-user': '203' };
    if (caller.includes('another')) return { 'x-test-role': 'developer', 'x-test-user': '202' };
    if (caller.includes('handoff')) return { 'x-test-role': 'developer', 'x-test-user': '201' };
    return { 'x-test-role': 'developer', 'x-test-user': '201' };
  }
  if (caller.startsWith('sales')) return { 'x-test-role': 'sales' };
  if (caller.startsWith('Maker')) return { 'x-maker-host-token': 'maker-token' };
  return {};
}

function clientFor(item) {
  if (item.id === 'developer-own-client') return 'syn-own';
  if (item.id === 'developer-handoff' || item.id === 'developer-other-client') return 'syn-handoff';
  if (item.id === 'developer-not-visible') return 'syn-hidden';
  return 'syn-own';
}

test.describe('compliance sign-off', { concurrency: 1 }, () => {
  let base;
  let close;
  test.before(async () => {
    const started = await listen(buildApp());
    base = started.base;
    close = started.close;
  });
  test.after(async () => { await close(); });

  test('the three records derive state from the newest row', () => {
    assert.equal(fixture.records.length, 3);
    for (const row of fixture.records) {
      assert.deepEqual(record.complianceState(row.compliance), row.state, row.id);
    }
    const withdrawn = fixture.records.find((row) => row.id === 'client-withdrawn');
    const oldestClient = withdrawn.compliance.signoffs.find((entry) => entry.role === 'client');
    const fromOldest = oldestClient.approve === true ? 'signed' : 'withdrawn';
    assert.equal(fromOldest, 'signed');
    assert.notEqual(fromOldest, withdrawn.state.client);
    assert.equal(withdrawn.state.client, 'withdrawn');
    assert.deepEqual(record.complianceOf({ compliance: fixture.defaultField }), { regulated: false, signoffs: [] });
  });

  test('every fixture PUT, refused writes, and the stored by', async () => {
    assert.equal(fixture.put.length > 0, true);
    let ran = 0;
    for (const item of fixture.put) {
      ran += 1;
      const id = clientFor(item);
      const headers = headersFor(item.caller);
      const beforeHistory = (record.readSeoRecord(id)?.history || []).length;
      const beforeSignoffs = (record.readSeoRecord(id)?.compliance?.signoffs || []).length;
      const before = snap(id);
      const response = await call(base, 'PUT', `/api/admin/sales-clients/${id}/seo/compliance`, { headers, body: item.body });
      if (item.expect.status) assert.equal(response.status, item.expect.status, `${item.id} ${response.text}`);
      if (item.expect.statusIn) assert.ok(item.expect.statusIn.includes(response.status), `${item.id} ${response.status}`);
      if (response.status === 200) {
        assert.equal(response.json.ok, true);
        assert.equal(response.json.seoRecorded, true);
        assert.deepEqual(Object.keys(response.json.compliance).sort(), ['regulated', 'signoffs', 'state']);
        assert.deepEqual(Object.keys(response.json.compliance.state).sort(), ['asoldi', 'client']);
        for (const role of ['asoldi', 'client']) {
          assert.ok(['signed', 'withdrawn', 'missing'].includes(response.json.compliance.state[role]));
        }
        const stored = record.readSeoRecord(id);
        if (Number.isInteger(item.expect.historyAdded)) assert.equal(stored.history.length, beforeHistory + item.expect.historyAdded);
        if (Number.isInteger(item.expect.signoffsAdded)) assert.equal(stored.compliance.signoffs.length, beforeSignoffs + item.expect.signoffsAdded);
        const entry = stored.history[stored.history.length - 1];
        assert.equal(entry.action, 'compliance');
        assert.equal(entry.role, item.body.role);
        assert.equal(entry.approve, item.body.approve);
        if (item.expect.storedBy) assert.equal(stored.compliance.signoffs.at(-1).by, item.expect.storedBy);
        assert.notEqual(stored.compliance.signoffs.at(-1).by, 'someone-else');
      } else {
        if (item.expect.code) assert.equal(response.json.code, item.expect.code, item.id);
        if (item.expect.field) assert.equal(response.json.field, item.expect.field, item.id);
        if (item.expect.recordUnchanged) assert.deepEqual(snap(id), before);
      }
    }
    assert.equal(ran, fixture.put.length);

    const refused = [];
    const seed = snap('syn-own');
    for (const [headers, path] of [
      [{}, '/api/admin/sales-clients/syn-own/seo/compliance'],
      [{ 'x-test-role': 'sales' }, '/api/admin/sales-clients/syn-own/seo/compliance'],
      [{ 'x-maker-host-token': 'maker-token' }, '/api/admin/sales-clients/syn-own/seo/compliance'],
      [{ 'x-test-role': 'developer', 'x-test-user': '201' }, '/api/admin/sales-clients/syn-handoff/seo/compliance'],
      [{ 'x-test-role': 'developer', 'x-test-user': '202' }, '/api/admin/sales-clients/syn-handoff/seo/compliance'],
    ]) {
      const id = path.includes('syn-handoff') ? 'syn-handoff' : 'syn-own';
      const before = snap(id);
      const response = await call(base, 'PUT', path, { headers, body: { role: 'asoldi', approve: true } });
      refused.push(response.status);
      assert.notEqual(response.status, 200);
      assert.deepEqual(snap(id), before);
    }
    assert.ok(refused.length > 0);
    assert.equal(refused[0], 401);
    assert.equal(refused[1], 403);
    assert.ok(refused[2] === 401 || refused[2] === 403);
    assert.equal(refused[3], 403);
    assert.equal(refused[4], 403);
    assert.deepEqual(snap('syn-own'), seed);
  });

  test('twenty-one sign-offs keep twenty rows and every history entry', async () => {
    nowIso = '2026-12-06T10:00:00.000Z';
    const id = 'syn-cap';
    addClient(id, { developerOwnerId: 'developer:201' });
    for (let n = 0; n < 21; n += 1) {
      nowIso = new Date(Date.parse('2026-12-06T10:00:00.000Z') + n * 1000).toISOString();
      const response = await call(base, 'PUT', `/api/admin/sales-clients/${id}/seo/compliance`, {
        headers: { 'x-test-role': 'admin' },
        body: { role: n % 2 === 0 ? 'asoldi' : 'client', approve: true },
      });
      assert.equal(response.status, 200, response.text);
    }
    const stored = record.readSeoRecord(id);
    assert.equal(stored.compliance.signoffs.length, 20);
    assert.equal(stored.history.filter((entry) => entry.action === 'compliance').length, 21);
    assert.equal(stored.compliance.regulated, false);
    assert.equal(stored.compliance.signoffs[0].at > '2026-12-06T10:00:00.000Z', true);
  });

  test('the developer and the admin each add one history entry, and the Maker read keeps field order', async () => {
    const id = 'syn-maker';
    addClient(id, { developerOwnerId: 'developer:201' });
    const off = await call(base, 'GET', `/api/internal/maker/seo-record?salesClientId=${id}`, { headers: { 'x-maker-host-token': 'maker-token' } });
    assert.equal(off.status, 404);
    assert.equal(off.json.code, 'disabled');

    nowIso = '2026-12-03T10:00:00.000Z';
    const before = (record.readSeoRecord(id)?.history || []).length;
    const asDeveloper = await call(base, 'PUT', `/api/admin/sales-clients/${id}/seo/compliance`, {
      headers: { 'x-test-role': 'developer', 'x-test-user': '201' },
      body: { role: 'asoldi', approve: true },
    });
    assert.equal(asDeveloper.status, 200);
    assert.equal(record.readSeoRecord(id).history.length, before + 1);
    nowIso = '2026-12-04T09:30:00.000Z';
    const asAdmin = await call(base, 'PUT', `/api/admin/sales-clients/${id}/seo/compliance`, {
      headers: { 'x-test-role': 'admin' },
      body: { role: 'client', approve: true, by: 'someone-else' },
    });
    assert.equal(asAdmin.status, 200);
    assert.equal(record.readSeoRecord(id).history.length, before + 2);
    assert.equal(asAdmin.json.compliance.signoffs.at(-1).by, 'admin');
    assert.equal(asAdmin.json.compliance.state.asoldi, 'signed');
    assert.equal(asAdmin.json.compliance.state.client, 'signed');

    const saved = settingsStore.saveAutomationSettings({ seo: { recordPull: { enabled: true } } }, { dataDir, by: 'test' });
    assert.equal(saved.ok, true, JSON.stringify(saved.errors));
    const maker = await call(base, 'GET', `/api/internal/maker/seo-record?salesClientId=${id}`, { headers: { 'x-maker-host-token': 'maker-token' } });
    assert.equal(maker.status, 200);
    const keys = Object.keys(maker.json.record);
    assert.deepEqual(keys, ['salesClientId', 'agreedKeywords', 'pageMap', 'planBuiltAt', 'updatedAt', 'compliance']);
    assert.ok(keys.slice(0, -1).length > 0);
    assert.equal(maker.json.record.salesClientId, id);
    assert.deepEqual(maker.json.record.compliance.signoffs.map((row) => row.role), ['asoldi', 'client']);
    assert.equal(maker.json.record.compliance.regulated, false);
  });
});
