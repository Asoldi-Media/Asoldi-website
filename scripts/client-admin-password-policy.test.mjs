// The client CMS admin password set from the hub: 8 to 1024 characters and not a known default,
// refused with a Norwegian message before anything is hashed or stored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-client-admin-pw-'));
process.env.APP_DATA_DIR = dataDir;
process.env.PERSIST_PRODUCTION_ENV = '0';

const policy = await import('../lib/client-admin-password.js');
const hub = await import('../data/hub.js');

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const SITE_ID = 'site-pw-1';
function seedSite(clientAdmin = {}) {
  writeFileSync(join(dataDir, 'sites.json'), JSON.stringify([{
    id: SITE_ID,
    name: 'Password test',
    domain: 'pw.example.no',
    site_key: 'p'.repeat(32),
    clientAdmin: { username: 'eier', email: 'eier@example.no', ...clientAdmin },
  }]));
}
function storedAdmin() {
  return JSON.parse(readFileSync(join(dataDir, 'sites.json'), 'utf8'))[0].clientAdmin;
}

test('policy: shorter than 8 characters, longer than 1024 or a known default is refused, in Norwegian', () => {
  const {
    clientAdminPasswordProblem: problem,
    CLIENT_ADMIN_PASSWORD_TOO_SHORT: short,
    CLIENT_ADMIN_PASSWORD_TOO_LONG: long,
    CLIENT_ADMIN_PASSWORD_TOO_COMMON: common,
  } = policy;
  assert.match(short, /minst 8 tegn/);
  assert.equal(long, 'Passordet kan ha høyst 1024 tegn.', 'the CMS wording');
  assert.match(common, /for enkelt å gjette/);
  for (const value of ['', 'a', 'abc1234', '       ', '  abc12  ', undefined, null, 12345678, ['12345678']]) {
    assert.equal(problem(value), short, JSON.stringify(value));
  }
  for (const value of ['changeme', 'CHANGEME', ' change-me ', 'password', 'Password', 'passord', '12345678', '123456789', 'administrator', 'Admin  ']) {
    const expected = value.trim().length < 8 ? short : common;
    assert.equal(problem(value), expected, value);
  }
  for (const value of ['kafe-bakke-2026', 'Tr0ll-og-Fjell', '12345678x', 'passord1!', 'k'.repeat(1024), ` ${'k'.repeat(1022)} `]) {
    assert.equal(problem(value), '', value.slice(0, 20));
  }
  // The CMS sign-in refuses anything longer than 1024 characters (spaces count), so the hub does too.
  assert.equal(policy.CLIENT_ADMIN_MAX_PASSWORD_LENGTH, 1024);
  for (const value of ['k'.repeat(1025), ` ${'k'.repeat(1023)} `, 'x'.repeat(5000)]) {
    assert.equal(problem(value), long, `length ${value.length}`);
  }
  // Everything the CMS refuses is refused here too (website-cms server/auth-hardening.js and server/secret.js).
  for (const value of ['changeme', 'change-me', 'admin', 'password', 'passord', '12345678', '123456789', 'administrator']) {
    assert.ok(policy.CLIENT_ADMIN_KNOWN_DEFAULT_PASSWORDS.includes(value), value);
  }
});

test('updateClientAdmin: a weak password is refused with 400 and nothing is stored', async () => {
  const oldHash = await bcrypt.hash('the-old-password-1', 4);
  seedSite({ passwordHash: oldHash, pendingSync: false });
  for (const password of ['short', 'changeme', '12345678', 'Passord ', 42, 'k'.repeat(1025)]) {
    const result = await hub.updateClientAdmin(SITE_ID, { name: 'Ny eier', password });
    assert.equal(result.ok, false, String(password).slice(0, 20));
    assert.equal(result.status, 400);
    assert.match(result.error, /minst 8 tegn|høyst 1024 tegn|for enkelt å gjette/);
    const admin = storedAdmin();
    assert.equal(admin.passwordHash, oldHash, 'hash unchanged');
    assert.equal(admin.pendingSync, false, 'nothing queued for the CMS');
    assert.notEqual(admin.name, 'Ny eier', 'the other fields are not saved either');
  }
});

test('updateClientAdmin: a good password is hashed and queued; no password keeps the old one', async () => {
  seedSite();
  const ok = await hub.updateClientAdmin(SITE_ID, { name: 'Eier', password: 'kafe-bakke-2026' });
  assert.equal(ok.ok, true);
  assert.equal(ok.site.clientAdmin.passwordSet, true);
  assert.equal('passwordHash' in ok.site.clientAdmin, false, 'the API never returns the hash');
  const first = storedAdmin();
  assert.equal(first.pendingSync, true);
  assert.ok(await bcrypt.compare('kafe-bakke-2026', first.passwordHash));
  for (const password of [undefined, null, '']) {
    const kept = await hub.updateClientAdmin(SITE_ID, { name: 'Eier 2', password });
    assert.equal(kept.ok, true);
    assert.equal(storedAdmin().passwordHash, first.passwordHash);
  }
  assert.equal(storedAdmin().name, 'Eier 2');
  const missing = await hub.updateClientAdmin('no-such-site', { password: 'kafe-bakke-2026' });
  assert.deepEqual([missing.ok, missing.status], [false, 404]);
});

test('updateSite: a password hash or pending flag in a site patch is ignored', async () => {
  const oldHash = await bcrypt.hash('the-old-password-1', 4);
  seedSite({ passwordHash: oldHash, pendingSync: false });
  const weakHash = await bcrypt.hash('changeme', 4);
  const result = hub.updateSite(SITE_ID, { clientAdmin: { name: 'Via site patch', passwordHash: weakHash, pendingSync: true } });
  assert.equal(result.ok, true);
  const admin = storedAdmin();
  assert.equal(admin.name, 'Via site patch', 'other client admin fields still update');
  assert.equal(admin.passwordHash, oldHash);
  assert.equal(admin.pendingSync, false);
  assert.equal(hub.getSiteConfig('p'.repeat(32), false, { includeAdmin: true }).pendingAdmin, null, 'nothing is handed to the CMS');
});

test('data/hub.js has no rule of its own: it re-exports this one, under the names other hub code uses', () => {
  assert.equal(hub.clientAdminPasswordProblem, policy.clientAdminPasswordProblem);
  assert.equal(hub.MIN_CLIENT_ADMIN_PASSWORD_LENGTH, policy.CLIENT_ADMIN_MIN_PASSWORD_LENGTH);
  assert.equal(hub.WEAK_CLIENT_ADMIN_PASSWORDS, policy.CLIENT_ADMIN_KNOWN_DEFAULT_PASSWORDS);
  const source = readFileSync(new URL('../data/hub.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /function clientAdminPasswordProblem|const (?:WEAK_CLIENT_ADMIN_PASSWORDS|MIN_CLIENT_ADMIN_PASSWORD_LENGTH)\b/, 'no second copy in data/hub.js');
  assert.doesNotMatch(source, /Password must be at least|not a common default/, 'no English copy of the messages');
  // Fine is '' (falsy), so callers can test the result either way.
  assert.equal(hub.clientAdminPasswordProblem('long-enough-and-own'), '');
});
