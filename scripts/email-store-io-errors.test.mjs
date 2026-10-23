// WS7.1 / WS7.14 / WS7.39: file errors fail fast and fail closed, and never block the event loop.
// This file patches fs.readFileSync for the whole process, so it runs on its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-email-io-'));
process.env.APP_DATA_DIR = dataDir;
process.env.SALES_CONTACT_EMAIL = 'salg@asoldi.test';
process.env.BOOKING_INBOX_EMAIL = 'booking@asoldi.test';

const store = await import('../data/email-store.js');
const owners = await import('../lib/owner-recipients.js');
const unsub = await import('../lib/asoldi-unsubscribe.js');

const site = { id: 'site_io', site_key: 'key_io', domain: 'io.example.no', name: 'IO', clientAdmin: { email: 'eier@example.no' } };
const originalReadFileSync = fs.readFileSync;

/** Make every read of a path matching `pattern` throw `code` until the returned restore() runs. */
function failReads(pattern, code) {
  fs.readFileSync = function patched(path, ...rest) {
    if (pattern.test(String(path))) {
      const error = new Error(`${code}: simulated`);
      error.code = code;
      throw error;
    }
    return originalReadFileSync.call(this, path, ...rest);
  };
  syncBuiltinESMExports();
  return () => {
    fs.readFileSync = originalReadFileSync;
    syncBuiltinESMExports();
  };
}

function timed(fn) {
  const started = process.hrtime.bigint();
  const value = fn();
  return { value, ms: Number(process.hrtime.bigint() - started) / 1e6 };
}

test.before(async () => {
  await store.patchEmailSite('site_io', { ownerRouting: 'owner+asoldi-bcc', ownerRoutingSetAt: new Date().toISOString() });
  await unsub.recordAsoldiSuppression({ emails: ['optout@example.no'], source: 'unsubscribe-link' });
  assert.equal(existsSync(join(dataDir, 'backups', 'email-sites.json.latest.json')), true);
  assert.equal(existsSync(join(dataDir, 'backups', 'email-suppressions.json.latest.json')), true);
});

for (const code of ['EACCES', 'EPERM', 'EBUSY']) {
  test(`WS7.1: ${code} on a data file and its backup returns in < 200 ms; routing keeps today's inbox and marketing fails closed`, () => {
    // Data files and their backups only (not the lockfiles next to them).
    const restore = failReads(/email-(sites|suppressions)\.json(\.latest\.json)?$/, code);
    try {
      const routing = timed(() => owners.resolveFormRouting(site));
      assert.ok(routing.ms < 200, `resolveFormRouting blocked ${routing.ms.toFixed(0)} ms`);
      assert.deepEqual(routing.value, { mode: '' }, 'an unreadable switch means today\'s behaviour');
      const suppressed = timed(() => unsub.isAsoldiMarketingSuppressed('someone@example.no'));
      assert.ok(suppressed.ms < 200, `isAsoldiMarketingSuppressed blocked ${suppressed.ms.toFixed(0)} ms`);
      assert.equal(suppressed.value, true, 'unknown opt-out state counts as suppressed');
      const card = timed(() => unsub.isAsoldiClientSuppressed('c_1'));
      assert.ok(card.ms < 200);
      assert.equal(card.value, true);
    } finally {
      restore();
    }
  });
}

test('WS7.1: a hard error on the live file falls back to the backup at once', () => {
  const restore = failReads(/[\\/]email-sites\.json$/, 'EACCES');
  try {
    const routing = timed(() => owners.resolveFormRouting(site));
    assert.ok(routing.ms < 100, `took ${routing.ms.toFixed(0)} ms`);
    assert.equal(routing.value.mode, 'owner+asoldi-bcc', 'read from backups/email-sites.json.latest.json');
    assert.equal(routing.value.to, 'eier@example.no');
  } finally {
    restore();
  }
});

test('WS7.1: a locked write on an unreadable record fails fast instead of outliving the 10 s lock', async () => {
  const restore = failReads(/email-suppressions\.json(\.latest\.json)?$/, 'EACCES');
  const started = Date.now();
  try {
    await assert.rejects(unsub.recordAsoldiSuppression({ emails: ['ny@example.no'], source: 'unsubscribe-link' }), (error) => error.code === 'EMAIL_STORE_UNREADABLE');
  } finally {
    restore();
  }
  assert.ok(Date.now() - started < 500);
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'email-suppressions.json'), 'utf8')).asoldi['ny@example.no'], undefined);
});

test('WS7.1: patchEmailSecrets refuses to write over a damaged or unreadable secrets file', async () => {
  await store.patchEmailSecrets({ brevoApiKey: 'fake-brevo-io-test', siteKeys: { site_io: 'fake-site-key' } });
  const path = join(dataDir, 'secrets', 'email-secrets.json');
  const good = readFileSync(path, 'utf8');
  writeFileSync(path, '{"brevoApiKey": "fake', 'utf8');
  await assert.rejects(store.patchEmailSecrets({ brevoApiKey: 'fake-brevo-io-new' }), (error) => {
    assert.equal(error.code, 'EMAIL_SECRETS_UNREADABLE');
    assert.equal(String(error.message).includes('fake'), false, 'the error never quotes the file');
    return true;
  });
  assert.equal(readFileSync(path, 'utf8'), '{"brevoApiKey": "fake', 'nothing was written');
  writeFileSync(path, good, 'utf8');
  const restore = failReads(/email-secrets\.json$/, 'EACCES');
  try {
    await assert.rejects(store.patchEmailSecrets({ siteKeys: { other: 'fake-other' } }), (error) => error.code === 'EMAIL_SECRETS_UNREADABLE');
    assert.equal(store.resolveBrevoKey({ env: {} }), null, 'lookups stay lenient');
  } finally {
    restore();
  }
  assert.equal(readFileSync(path, 'utf8'), good, 'the per-site keys survived');
  assert.equal(store.resolveBrevoKey({ env: {} }), 'fake-brevo-io-test');
});

test('WS7.1: the fencing token never goes backwards and a lease is never taken on a read error', async () => {
  const first = await store.acquireLease('io-lease', 60_000);
  assert.ok(first);
  const token = first.token;
  await first.release();
  const fence = join(dataDir, 'email-locks', 'io-lease.fence');
  const restoreFence = failReads(/io-lease\.fence$/, 'EACCES');
  try {
    assert.throws(() => store.currentFence('io-lease'), (error) => error.code === 'EMAIL_FENCE_UNREADABLE');
    await assert.rejects(store.acquireLease('io-lease', 60_000), (error) => error.code === 'EMAIL_FENCE_UNREADABLE', 'no token 1 is issued');
  } finally {
    restoreFence();
  }
  writeFileSync(fence, 'garbage', 'utf8');
  await assert.rejects(store.acquireLease('io-lease', 60_000), (error) => error.code === 'EMAIL_FENCE_UNREADABLE');
  writeFileSync(fence, String(token), 'utf8');
  const live = await store.acquireLease('io-lease', 60_000);
  assert.equal(live.token, token + 1);
  const restoreLease = failReads(/io-lease\.lease$/, 'EACCES');
  try {
    await assert.rejects(store.acquireLease('io-lease', 60_000), (error) => error.code === 'EACCES', 'a live lease may exist: nobody takes it');
    assert.equal(live.isCurrent(), false, 'an unreadable lease is not current');
  } finally {
    restoreLease();
  }
  assert.equal(live.isCurrent(), true);
  await live.release();
});

test('WS7.1: releasing a lock never deletes a lockfile that is not ours (empty nonce after a stale reap)', async () => {
  const lockPath = join(dataDir, 'email-locks', 'io-release.lock');
  await store.withFileLock('io-release', () => {
    // Our lock was reaped and another process has just created its own with O_EXCL (not written yet).
    writeFileSync(lockPath, '', 'utf8');
  });
  assert.equal(existsSync(lockPath), true, 'the other process keeps its lock');
  rmSync(lockPath);
  await store.withFileLock('io-release', () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 1, at: Date.now(), nonce: 'someone-else' }), 'utf8');
  });
  assert.equal(existsSync(lockPath), true);
  rmSync(lockPath);
  await store.withFileLock('io-release', () => {});
  assert.equal(existsSync(lockPath), false, 'our own lock is released');
});

test('WS7.14: a lost opt-out record (both files gone after it existed) fails closed and raises an alert', async () => {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    rmSync(join(dataDir, 'email-suppressions.json'));
    rmSync(join(dataDir, 'backups', 'email-suppressions.json.latest.json'));
    assert.equal(existsSync(join(dataDir, 'secrets', store.SUPPRESSIONS_MARKER)), true, 'the marker was written with the record');
    assert.throws(() => store.readEmailSuppressions(), (error) => error.code === 'EMAIL_STORE_UNREADABLE' && error.missing === true);
    assert.equal(unsub.isAsoldiMarketingSuppressed('optout@example.no'), true, 'the old opt-out is still honoured');
    assert.equal(unsub.isAsoldiMarketingSuppressed('anyone@example.no'), true, 'fails closed for everyone');
    await assert.rejects(unsub.recordAsoldiSuppression({ emails: ['new@example.no'] }), (error) => error.code === 'EMAIL_STORE_UNREADABLE', 'no fresh file papers over the loss');
    assert.equal(existsSync(join(dataDir, 'email-suppressions.json')), false);
    assert.ok(errors.some((line) => line.includes('ALERT') && line.includes('email-suppressions.json')), 'ops alert on the console');
    assert.equal(errors.some((line) => line.includes('optout@example.no')), false, 'the alert carries no address');
  } finally {
    console.error = original;
  }
  // An operator who knows the record is really empty removes the marker on purpose.
  rmSync(join(dataDir, 'secrets', store.SUPPRESSIONS_MARKER));
  assert.deepEqual(store.readEmailSuppressions(), {});
  assert.equal(unsub.isAsoldiMarketingSuppressed('anyone@example.no'), false);
});

test('WS7.14: a fresh install (no record, no marker) is not suppressed and writes no marker on read', () => {
  const marker = join(dataDir, 'secrets', store.SUPPRESSIONS_MARKER);
  assert.equal(existsSync(marker), false);
  assert.equal(unsub.isAsoldiMarketingSuppressed('anyone@example.no'), false);
  assert.equal(existsSync(marker), false);
});

test.after(() => {
  fs.readFileSync = originalReadFileSync;
  syncBuiltinESMExports();
  mkdirSync(dataDir, { recursive: true });
  rmSync(dataDir, { recursive: true, force: true });
});
