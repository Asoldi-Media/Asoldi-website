// Golden harness, hub side: scripts/golden/seed-hub.mjs seeds a local data folder from fixture clients
// (only below a .local-data folder), and a hub booted on that data in safe mode reports safeMode:true,
// lists the seeded clients on the developer board, and puts the pre-workshop email for a client marked
// contract-signed in the safe-mode outbox (nothing is sent).
//
// The fixtures here are invented in the test (example.com addresses, no phone numbers); the real fixture
// set lives in the private Maker repo and is read only at run time.
//
// node --test scripts/golden/hub-golden.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootHub } from '../safe-mode/hub-boot.mjs';
import { assertLocalDataDir, resolveFixtureValue, sentencesFromText } from './seed-hub.mjs';
import { buildPreWorkshopEmail } from '../../lib/sales-email.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = join(HERE, 'seed-hub.mjs');

function fixtureSet(root) {
  const dir = join(root, 'fixtures');
  const clients = [
    { id: 'demo-bakery', businessName: 'Example Bakery AS', contactEmail: 'owner@example.com', domain: 'bakery.example', offer: 'sent' },
    { id: 'demo-garage', businessName: 'Example Garage AS', contactEmail: 'garage@example.com', domain: '', offer: 'none' },
  ];
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ version: 1, clients: clients.map((c) => ({ id: c.id, kind: 'synthetic', tier: 'tier-1-standard', lang: 'nb' })) }));
  for (const c of clients) {
    const cdir = join(dir, c.id);
    mkdirSync(join(cdir, 'transcripts'), { recursive: true });
    writeFileSync(join(cdir, 'client.json'), JSON.stringify({
      version: 1,
      id: c.id,
      kind: 'synthetic',
      label: c.businessName,
      salesClient: { id: `golden_${c.id}`, businessName: c.businessName, contactPerson: 'Kari Example', contactEmail: c.contactEmail, contactPhone: '', industry: 'bakery', websiteDomain: c.domain || null, status: 'active' },
      sitePlan: { version: 1, status: 'active', tierId: 'tier-1-standard', services: ['site', 'changes', 'blog'], pages: 5 },
      offer: { status: c.offer, title: 'Nettside', summary: 'Tier 1 website.' },
    }));
    writeFileSync(join(cdir, 'transcripts.json'), JSON.stringify({ version: 1, client: c.id, meetings: { sales: { storage: 'inline', file: 'transcripts/sales.txt', date: '2026-10-20', language: 'nb' }, workshop: null } }));
    writeFileSync(join(cdir, 'transcripts', 'sales.txt'), 'Selger: Hei, hva trenger dere?\nKunde: En enkel nettside med menyen vår.\nSelger: Det ordner vi.\n');
  }
  return dir;
}

function runSeed(args) {
  const cwd = mkdtempSync(join(tmpdir(), 'golden-seed-cwd-'));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(APP_DATA_DIR|DATA_DIR|GOLDEN_|HUB_SAFE_MODE|ADMIN_)/.test(key)) delete env[key];
  const out = spawnSync(process.execPath, [SEED, ...args], { cwd, env, encoding: 'utf8', timeout: 60_000 });
  rmSync(cwd, { recursive: true, force: true });
  return out;
}

test('seed-hub refuses a data folder that is not below .local-data, and writes nothing there', () => {
  const root = mkdtempSync(join(tmpdir(), 'golden-hub-refuse-'));
  const fixtures = fixtureSet(root);
  const target = join(root, 'data');
  const out = runSeed(['--data-dir', target, '--fixtures-dir', fixtures]);
  assert.equal(out.status, 2, out.stderr);
  assert.match(out.stderr, /not below a \.local-data folder/);
  assert.equal(existsSync(target), false);
  assert.throws(() => assertLocalDataDir(join(root, 'local-data')), /refused/);
  assert.equal(assertLocalDataDir(join(root, '.local-data', 'golden')), join(root, '.local-data', 'golden'));
  rmSync(root, { recursive: true, force: true });
});

test('fixture helpers: private placeholders resolve only from the private folder; meeting text becomes sentences', () => {
  const root = mkdtempSync(join(tmpdir(), 'golden-hub-private-'));
  mkdirSync(join(root, 'demo'), { recursive: true });
  writeFileSync(join(root, 'demo', 'facts.json'), JSON.stringify({ contact: { email: 'kari@example.com' } }));
  const placeholder = { $private: 'facts.contact.email', alg: 'hmac-sha256', sha256: 'x' };
  assert.equal(resolveFixtureValue('demo', placeholder, root), 'kari@example.com');
  assert.equal(resolveFixtureValue('demo', placeholder, ''), undefined);
  assert.equal(resolveFixtureValue('demo', 'plain', ''), 'plain');
  assert.deepEqual(sentencesFromText('A: hei\nB: hallo\n'), [{ index: 0, speaker_name: 'A', text: 'hei' }, { index: 1, speaker_name: 'B', text: 'hallo' }]);
  rmSync(root, { recursive: true, force: true });
});

test('a safe-mode hub on the seeded data: health, the developer board, and the pre-workshop email in the outbox', async () => {
  const root = mkdtempSync(join(tmpdir(), 'golden-hub-'));
  const fixtures = fixtureSet(root);
  const dataDir = join(root, '.local-data', 'golden');
  const seeded = runSeed(['--data-dir', dataDir, '--clients', 'all', '--fixtures-dir', fixtures]);
  assert.equal(seeded.status, 0, seeded.stderr);
  const summary = JSON.parse(seeded.stdout);
  assert.deepEqual(summary.clients.map((c) => c.salesClientId), ['golden_demo-bakery', 'golden_demo-garage']);
  assert.equal(summary.clients[0].meetings, 1);
  assert.equal(summary.clients[0].site, 'bakery.example');
  const admin = JSON.parse(readFileSync(join(dataDir, 'secrets', 'local-admin.json'), 'utf8'));
  assert.ok(admin.password.length >= 20, 'a random local password');
  // Seeding twice keeps one record per client and the same admin.
  const again = runSeed(['--data-dir', dataDir, '--clients', 'all', '--fixtures-dir', fixtures]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'secrets', 'local-admin.json'), 'utf8')).password, admin.password);
  const salesFile = JSON.parse(readFileSync(join(dataDir, 'sales-clients.json'), 'utf8'));
  const list = Array.isArray(salesFile) ? salesFile : salesFile.clients || [];
  assert.equal(list.filter((c) => String(c.id).startsWith('golden_')).length, 2);

  const hub = await bootHub({ HUB_SAFE_MODE: '1' }, { seed: (target) => cpSync(dataDir, target, { recursive: true }) });
  try {
    assert.equal(hub.health?.safeMode, true, hub.log().slice(-2000));
    const token = await hub.adminToken(admin.username, admin.password);
    assert.ok(token, 'the seeded local admin can sign in');
    const auth = { authorization: `Bearer ${token}` };
    const board = await fetch(`${hub.base}/api/admin/development`, { headers: auth });
    assert.equal(board.status, 200);
    const boardText = await board.text();
    assert.match(boardText, /golden_demo-bakery/);
    assert.match(boardText, /golden_demo-garage/);
    const signed = await fetch(`${hub.base}/api/admin/sales/golden_demo-bakery/progression`, {
      method: 'PATCH',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'contractSigned', value: true }),
    });
    assert.equal(signed.status, 200, await signed.clone().text());
    const indexFile = join(hub.dataDir, 'outbox', 'index.jsonl');
    let rows = [];
    for (let i = 0; i < 20 && !rows.length; i += 1) {
      if (existsSync(indexFile)) rows = readFileSync(indexFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
      if (!rows.length) await new Promise((r) => setTimeout(r, 250));
    }
    // Exactly one mail to the client, and it is the pre-workshop mail (its subject, not any other kind).
    const expectedSubject = buildPreWorkshopEmail({ businessName: 'Example Bakery AS' }, {}, { hasTime: false }).subject;
    const toClient = rows.filter((row) => (row.to || []).some((address) => String(address).toLowerCase().includes('owner@example.com')));
    assert.equal(toClient.length, 1, `one mail to the client in the outbox (${rows.length} outbox rows)`);
    assert.equal(toClient[0].subject, expectedSubject, 'the mail to the client is the pre-workshop email');
    assert.equal(rows.filter((row) => row.subject === expectedSubject).length, 1, 'the pre-workshop email went out once');
    assert.ok(readdirSync(join(hub.dataDir, 'outbox')).length >= 1);
    const egress = hub.egressRows();
    assert.ok(egress.some((row) => row.event === 'audit-start'), 'the egress recorder ran inside the hub process');
    assert.deepEqual(egress.filter((row) => !row.event && !row.listed), [], 'no unlisted egress');
  } finally {
    await hub.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
