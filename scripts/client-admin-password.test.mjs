import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// data/hub.js resolves the data dir when it loads: point it at a throwaway folder first.
const dataDir = mkdtempSync(path.join(tmpdir(), 'hub-client-admin-'));
process.env.APP_DATA_DIR = dataDir;
const hub = await import('../data/hub.js');

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

test('client admin: short or well-known passwords are refused with 400 before anything is stored', async () => {
  const created = hub.createSite({ name: 'Example shop', domain: 'shop.example' });
  const id = created.site?.id || created.id;
  assert.ok(id, 'site created');
  for (const weak of ['short', 'changeme', 'Password', ' admin ', '12345678', 'administrator']) {
    const result = await hub.updateClientAdmin(id, { username: 'owner', password: weak });
    assert.equal(result.ok, false, weak);
    assert.equal(result.status, 400, weak);
  }
  assert.equal(hub.getSiteById(id).clientAdmin.passwordHash || '', '', 'nothing was stored');
  const ok = await hub.updateClientAdmin(id, { username: 'owner', password: 'long-enough-and-own' });
  assert.equal(ok.ok, true);
  assert.equal(hub.getSiteById(id).clientAdmin.pendingSync, true);
  const nameOnly = await hub.updateClientAdmin(id, { name: 'Owner' });
  assert.equal(nameOnly.ok, true, 'a change without a password is not checked');
});

test('client admin: the rule matches the CMS (8 characters, common defaults refused)', () => {
  assert.equal(hub.MIN_CLIENT_ADMIN_PASSWORD_LENGTH, 8);
  assert.notEqual(hub.clientAdminPasswordProblem('1234567'), '');
  assert.equal(hub.clientAdminPasswordProblem('12345679'), '');
  assert.notEqual(hub.clientAdminPasswordProblem('CHANGE-ME'), '');
});
