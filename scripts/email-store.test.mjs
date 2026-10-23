import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-email-store-'));
process.env.APP_DATA_DIR = dataDir;
delete process.env.BREVO_API_KEY;

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const storeUrl = pathToFileURL(join(repoRoot, 'data', 'email-store.js')).href;
const store = await import(storeUrl);
const { createEmailLog } = await import(pathToFileURL(join(repoRoot, 'lib', 'email-log.js')).href);

function runChild(code) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, APP_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve({ code, out, err })));
  const line = (pattern) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child never printed ${pattern}: ${err}`)), 15_000);
    const check = () => {
      const match = out.match(pattern);
      if (match) {
        clearTimeout(timer);
        resolve(match);
      }
    };
    child.stdout.on('data', check);
    check();
  });
  return { child, exited, line };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function walk(dir, skip = new Set()) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (skip.has(entry.name)) continue;
    if (entry.isDirectory()) out.push(...walk(path, skip));
    else out.push(path);
  }
  return out;
}

test('WS7.1 (a): the first call creates both secret files, the second returns the same secrets', () => {
  const unsubPath = join(dataDir, 'secrets', 'email-unsub-key');
  const webhookPath = join(dataDir, 'secrets', 'email-webhook-token');
  assert.equal(existsSync(unsubPath), false);
  assert.equal(existsSync(webhookPath), false);
  const first = store.readEmailSecrets();
  assert.equal(existsSync(unsubPath), true);
  assert.equal(existsSync(webhookPath), true);
  assert.match(first.unsubKey, /^[0-9a-f]{64}$/, '32 random bytes');
  assert.match(first.webhookToken, /^[0-9a-f]{48}$/, '24 random bytes');
  const second = store.readEmailSecrets();
  assert.equal(second.unsubKey, first.unsubKey);
  assert.equal(second.webhookToken, first.webhookToken);
  if (process.platform !== 'win32') {
    assert.equal(statSync(unsubPath).mode & 0o777, 0o600);
  }
});

test('WS7.1 (a): another process reads the same secrets from disk', async () => {
  const mine = store.readEmailSecrets();
  const { line, exited } = runChild(`
    const store = await import(${JSON.stringify(storeUrl)});
    const s = store.readEmailSecrets();
    console.log('SAME=' + (s.unsubKey === ${JSON.stringify(mine.unsubKey)} && s.webhookToken === ${JSON.stringify(mine.webhookToken)}));
  `);
  const [, same] = await line(/SAME=(true|false)/);
  assert.equal(same, 'true');
  assert.equal((await exited).code, 0);
});

test('WS7.1 (b): resolveBrevoKey ignores a masked env value and falls back to the Superadmin paste', async () => {
  assert.equal(store.resolveBrevoKey({ env: { BREVO_API_KEY: '********' } }), null);
  assert.equal(store.resolveBrevoKey({ env: { BREVO_API_KEY: '   ' } }), null);
  assert.equal(store.resolveBrevoKey({ env: { BREVO_API_KEY: 'fake-brevo-test-env' } }), 'fake-brevo-test-env');
  assert.equal(store.brevoKeySource({ env: { BREVO_API_KEY: 'fake-brevo-test-env' } }), 'env');
  await store.patchEmailSecrets({ brevoApiKey: 'fake-brevo-test-paste' });
  assert.equal(store.resolveBrevoKey({ env: { BREVO_API_KEY: '********' } }), 'fake-brevo-test-paste');
  assert.equal(store.brevoKeySource({ env: {} }), 'secrets');
  assert.equal(store.resolveBrevoKey({ env: { BREVO_API_KEY: 'fake-brevo-test-env' } }), 'fake-brevo-test-env', 'env wins');
  await store.patchEmailSecrets({ brevoApiKey: '*****' });
  assert.equal(store.resolveBrevoKey({ env: {} }), null, 'a masked paste is not a key');
  assert.equal(store.brevoKeySource({ env: {} }), null);
  await store.patchEmailSecrets({ brevoApiKey: '' });
});

test('WS7.1: BREVO_API_KEY survives the durable production env backup', async () => {
  const { PRODUCTION_ENV_KEYS, mergeProductionEnv } = await import('../lib/persistent-env.js');
  assert.ok(PRODUCTION_ENV_KEYS.includes('BREVO_API_KEY'));
  assert.equal(mergeProductionEnv({}, { BREVO_API_KEY: 'fake-brevo-test' }).BREVO_API_KEY, 'fake-brevo-test');
});

test('WS7.1 (c): 100 parallel increments from each of two child processes lose 0 updates', async () => {
  const code = `
    const store = await import(${JSON.stringify(storeUrl)});
    await Promise.all(Array.from({ length: 100 }, () => store.withFileLock('email-ledger.json', () => {
      const current = store.readJson('email-ledger.json', { total: 0 });
      store.writeJsonAtomic('email-ledger.json', { total: current.total + 1 });
    })));
    console.log('DONE');
  `;
  const a = runChild(code);
  const b = runChild(code);
  const [ra, rb] = await Promise.all([a.exited, b.exited]);
  assert.equal(ra.code, 0, ra.err);
  assert.equal(rb.code, 0, rb.err);
  assert.equal(store.readJson('email-ledger.json').total, 200);
  const leftovers = readdirSync(dataDir).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'atomic writes leave no tmp files');
  assert.deepEqual(readdirSync(join(dataDir, 'email-locks')).filter((name) => name.endsWith('.lock')), [], 'locks are released');
});

test('WS7.1 (c): in one process, parallel withFileLock calls serialize', async () => {
  let inside = 0;
  let maxInside = 0;
  await Promise.all(Array.from({ length: 30 }, async () => store.withFileLock('serial-check', async () => {
    inside += 1;
    maxInside = Math.max(maxInside, inside);
    await sleep(1);
    inside -= 1;
  })));
  assert.equal(maxInside, 1);
  await assert.rejects(store.withFileLock('serial-check', () => { throw new Error('boom'); }), /boom/);
  assert.equal(await store.withFileLock('serial-check', () => 'next'), 'next', 'a failed holder releases the lock');
});

test('WS7.1 (d): a lockfile left by a killed process is reaped after the stale timeout', async () => {
  const { child, line, exited } = runChild(`
    const store = await import(${JSON.stringify(storeUrl)});
    store.withFileLock('stuck', () => { console.log('LOCKED'); return new Promise(() => {}); });
    setInterval(() => {}, 1000);
  `);
  await line(/LOCKED/);
  child.kill('SIGKILL');
  await exited;
  assert.equal(existsSync(join(dataDir, 'email-locks', 'stuck.lock')), true, 'the dead holder left its lockfile');
  const started = Date.now();
  const result = await store.withFileLock('stuck', () => 'mine', { staleMs: 800 });
  const waited = Date.now() - started;
  assert.equal(result, 'mine');
  assert.ok(waited >= 400, `waited ${waited} ms before taking over`);
});

test('WS7.1 (d): a lease held by a killed process is taken over after it expires, with a higher fencing token', async () => {
  const { child, line, exited } = runChild(`
    const store = await import(${JSON.stringify(storeUrl)});
    const lease = await store.acquireLease('email-dispatch', 1500);
    console.log('TOKEN=' + lease.token + ' AT=' + Date.now());
    setInterval(() => {}, 1000);
  `);
  const [, tokenText, atText] = await line(/TOKEN=(\d+) AT=(\d+)/);
  const childToken = Number(tokenText);
  child.kill('SIGKILL');
  await exited;
  assert.equal(await store.acquireLease('email-dispatch', 1500), null, 'still held until the TTL runs out');
  const wait = Number(atText) + 1600 - Date.now();
  if (wait > 0) await sleep(wait);
  const lease = await store.acquireLease('email-dispatch', 5000);
  assert.ok(lease, 'taken over after expiry');
  assert.ok(lease.token > childToken, `fencing token ${lease.token} > ${childToken}`);
  assert.equal(store.currentFence('email-dispatch'), lease.token);
  assert.equal(lease.isCurrent(), true);
  assert.equal(await store.acquireLease('email-dispatch', 5000), null, 'a second worker skips while the lease is live');
  assert.equal(await lease.renew(5000), true);
  assert.equal(await lease.release(), true);
  assert.equal(lease.isCurrent(), false);
  const next = await store.acquireLease('email-dispatch', 5000);
  assert.ok(next.token > lease.token);
  assert.equal(await lease.renew(), false, 'an old holder cannot renew a newer lease');
  await next.release();
});

test('WS7.1: settings default to dark and patches keep a backup snapshot', async () => {
  const defaults = store.readEmailSettings();
  assert.equal(defaults.rollout.mode, 'off');
  assert.equal(defaults.killSwitch, false);
  assert.equal(defaults.brevo.syncContacts, false);
  assert.equal(defaults.quota.limit, 300);
  assert.deepEqual(defaults.testRecipients, ['damian@asoldi.com', 'alexander@asoldi.com']);
  const saved = await store.saveEmailSettings({ rollout: { mode: 'allowlist', siteIds: ['site_test'] }, quota: { limit: 500 }, bogus: true });
  assert.equal(saved.rollout.mode, 'allowlist');
  assert.equal(saved.quota.limit, 500);
  assert.equal(saved.quota.safety, 15, 'nested defaults survive a partial patch');
  assert.equal('bogus' in saved, false, 'unknown keys are dropped');
  assert.equal(existsSync(join(dataDir, 'backups', 'email-settings.json.latest.json')), true);
  assert.equal(store.readEmailSettings().quota.limit, 500);
});

test('WS7.1: per-site rows merge nested patches and normalize owner routing', async () => {
  assert.equal(store.readEmailSite('site_none').ownerRouting, '');
  await store.patchEmailSite('site_a', { ownerRouting: 'owner+asoldi-bcc', ownerRoutingSetAt: '2026-10-23T10:00:00.000Z', dpa: { version: 'v1' } });
  await store.patchEmailSite('site_a', { dpa: { acceptedAt: '2026-10-23T11:00:00.000Z' }, ownerRecipients: [{ email: ' Eier@Example.no ', status: 'confirmed' }] });
  const row = store.readEmailSite('site_a');
  assert.equal(row.ownerRouting, 'owner+asoldi-bcc');
  assert.deepEqual(row.dpa, { acceptedAt: '2026-10-23T11:00:00.000Z', version: 'v1', attestedBy: '' });
  assert.deepEqual(row.ownerRecipients, [{ email: 'eier@example.no', status: 'confirmed', confirmedAt: '', source: '' }]);
  await store.patchEmailSite('site_a', { ownerRouting: 'everyone' });
  assert.equal(store.readEmailSite('site_a').ownerRouting, '', 'unknown modes fall back to unset');
});

test('WS7.1: suppressions restore from the backup and fail closed when nothing is readable', async () => {
  await store.updateEmailSuppressions((rows) => {
    rows.asoldi = { 'ola@example.no': { scope: 'marketing', source: 'unsubscribe-link', at: '2026-10-23T10:00:00.000Z' } };
  });
  const live = join(dataDir, 'email-suppressions.json');
  unlinkSync(live);
  assert.ok(store.readEmailSuppressions().asoldi['ola@example.no'], 'restored from backups/*.latest.json');
  assert.equal(existsSync(live), true, 'the live file is repaired');
  writeFileSync(live, '{"asoldi": {', 'utf8');
  assert.ok(store.readEmailSuppressions().asoldi['ola@example.no'], 'a torn live file falls back to the backup');
  writeFileSync(live, '{"asoldi": {', 'utf8');
  writeFileSync(join(dataDir, 'backups', 'email-suppressions.json.latest.json'), 'not json', 'utf8');
  assert.throws(() => store.readEmailSuppressions(), (error) => error.code === 'EMAIL_STORE_UNREADABLE');
  await assert.rejects(store.updateEmailSuppressions(() => {}), (error) => error.code === 'EMAIL_STORE_UNREADABLE', 'no write over an unreadable record');
  writeFileSync(live, JSON.stringify({ asoldi: {} }), 'utf8');
});

test('WS7.1: file names cannot escape the data dir', () => {
  assert.throws(() => store.readJson('../outside.json'), /bad file name/);
  assert.throws(() => store.writeJsonAtomic('a/../../b.json', {}), /bad file name/);
  assert.throws(() => store.readJson('C:\\x.json'), /bad file name/);
});

test('WS7.1 (f): no API view, data file or log line contains a secret', async () => {
  const captured = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  for (const key of Object.keys(original)) console[key] = (...args) => captured.push(args.map(String).join(' '));
  try {
    await store.patchEmailSecrets({ brevoApiKey: 'fake-brevo-secret-paste-value' });
    const secrets = store.readEmailSecrets();
    const values = [secrets.unsubKey, secrets.webhookToken, 'fake-brevo-secret-paste-value', 'fake-brevo-env-secret-value'];
    await store.saveEmailSettings({ killSwitch: false });
    await store.patchEmailSite('site_f', { ownerRouting: 'owner' });
    const log = createEmailLog({ flushMs: 0 });
    log.appendMessage({ siteId: 'site_f', kind: 'test', to: 'kunde@example.no', apiKey: secrets.unsubKey, html: `<p>${secrets.webhookToken}</p>` });
    log.appendEvent({ messageId: 'em_x', t: 'delivered', token: secrets.webhookToken });
    log.flushEvents();
    const views = JSON.stringify([
      store.emailStoreStatus({ env: { BREVO_API_KEY: 'fake-brevo-env-secret-value' } }),
      store.readEmailSettings(),
      store.readEmailSites(),
      log.statsFor({ siteId: 'site_f' }),
    ]);
    for (const value of values) assert.equal(views.includes(value), false, 'API views carry no secret');
    const files = walk(dataDir, new Set(['secrets']));
    assert.ok(files.some((file) => file.endsWith('.jsonl')), 'log files were written');
    for (const file of files) {
      const body = readFileSync(file, 'utf8');
      for (const value of values) assert.equal(body.includes(value), false, `${file} must not contain a secret`);
      assert.equal(body.includes('kunde@example.no'), false, `${file} must not contain a plain recipient`);
    }
    for (const line of captured) for (const value of values) assert.equal(line.includes(value), false);
  } finally {
    Object.assign(console, original);
  }
});

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});
