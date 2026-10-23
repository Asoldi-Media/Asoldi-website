// The Fireflies archive on disk: locked atomic writes, no write without a change, backups that
// span hours, and an unreadable file that is never replaced by {} or a single record.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-ff-store-'));
process.env.APP_DATA_DIR = dataDir;
delete process.env.DATA_BACKUP_KEEP;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const store = await import('../lib/fireflies-store.js');

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-10-23T08:00:00.000Z');
const backupDir = join(dataDir, 'backups');
const quietErrors = (fn) => {
  const original = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = original;
  }
};

function backupsOf(file) {
  return existsSync(backupDir) ? readdirSync(backupDir).filter((name) => name.startsWith(`${file}.`)) : [];
}

function put(name, entries, nowMs = T0) {
  return store.updateFirefliesStore(name, (map) => {
    Object.assign(map, entries);
    return true;
  }, { nowMs });
}

test('a write happens only when the mutation reports a change', () => {
  store.resetFirefliesStoreForTests();
  put('notified', { m1: { at: '2026-10-23T08:00:00.000Z', state: 'sent' } });
  assert.equal(store.firefliesStoreHealth().notified.writes, 1);
  const path = store.firefliesStorePath('notified');
  const before = readFileSync(path, 'utf8');
  const result = store.updateFirefliesStore('notified', () => false);
  assert.equal(result.changed, false);
  assert.equal(store.firefliesStoreHealth().notified.writes, 1, 'no second write');
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.deepEqual(Object.keys(store.readFirefliesStore('notified')), ['m1']);
  assert.ok(backupsOf('fireflies-notified.json').includes('fireflies-notified.json.latest.json'));
});

test('an unreadable archive is read from its backup and never overwritten with {} or one record', () => {
  store.resetFirefliesStoreForTests();
  put('meetings', { a: { meetingId: 'a', transcript: 'Kari Test: Hei.' }, b: { meetingId: 'b', transcript: 'Ola: Takk.' } });
  const path = store.firefliesStorePath('meetings');
  // A process killed mid-write by the old in-place writer leaves a truncated file.
  writeFileSync(path, '{"a":{"meetingId":"a","transcr', 'utf8');
  store.resetFirefliesStoreForTests();
  const read = quietErrors(() => store.readFirefliesStore('meetings'));
  assert.deepEqual(Object.keys(read).sort(), ['a', 'b'], 'reads come from backups/*.latest.json');
  assert.equal(store.firefliesStoreHealth().meetings.source, 'backup');
  assert.equal(readFileSync(path, 'utf8'), '{"a":{"meetingId":"a","transcr', 'a read never writes');

  quietErrors(() => put('meetings', { c: { meetingId: 'c', transcript: 'Ny: Hallo.' } }));
  const repaired = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(Object.keys(repaired).sort(), ['a', 'b', 'c'], 'the write starts from the backup, not from {}');
  assert.equal(store.firefliesStoreHealth().meetings.restored, 1);
  const kept = backupsOf('fireflies-meetings.json').filter((name) => name.includes('.unreadable-'));
  assert.equal(kept.length, 1, 'the unreadable file is kept for a human');
  assert.equal(readFileSync(join(backupDir, kept[0]), 'utf8'), '{"a":{"meetingId":"a","transcr');
});

test('with no readable backup the write is refused and the file is left as it is', () => {
  store.resetFirefliesStoreForTests();
  const path = store.firefliesStorePath('meetings');
  writeFileSync(path, 'not json at all', 'utf8');
  for (const name of backupsOf('fireflies-meetings.json')) {
    if (!name.includes('.unreadable-')) writeFileSync(join(backupDir, name), '{broken', 'utf8');
  }
  assert.throws(
    () => quietErrors(() => put('meetings', { d: { meetingId: 'd' } })),
    (error) => error instanceof store.FirefliesStoreUnreadableError && error.code === 'FIREFLIES_STORE_UNREADABLE',
  );
  assert.equal(readFileSync(path, 'utf8'), 'not json at all');
  store.resetFirefliesStoreForTests();
  assert.deepEqual(quietErrors(() => store.readFirefliesStore('meetings')), {});
  const health = quietErrors(() => store.firefliesStoreHealth());
  assert.equal(health.meetings.source, 'unreadable');
  unlinkSync(path);
});

test('timestamped backups are kept at most hourly, so the history spans hours', () => {
  store.resetFirefliesStoreForTests();
  for (const name of backupsOf('fireflies-ingest-state.json')) unlinkSync(join(backupDir, name));
  const stamped = () => backupsOf('fireflies-ingest-state.json').filter((name) => /\d{4}-\d{2}-\d{2}T/.test(name) && !name.endsWith('.latest.json'));
  put('ingest', { lastScanAt: 'a' }, T0);
  put('ingest', { lastScanAt: 'b' }, T0 + 10 * 60 * 1000);
  put('ingest', { lastScanAt: 'c' }, T0 + 30 * 60 * 1000);
  assert.equal(stamped().length, 1, 'three writes within the hour keep one stamped copy');
  put('ingest', { lastScanAt: 'd' }, T0 + HOUR + 1000);
  assert.equal(stamped().length, 2);
  const latest = JSON.parse(readFileSync(join(backupDir, 'fireflies-ingest-state.json.latest.json'), 'utf8'));
  assert.equal(latest.lastScanAt, 'd', 'latest.json follows every write');
});

test('another process\'s write is picked up once the file changes', () => {
  store.resetFirefliesStoreForTests();
  put('notified', { x: { state: 'sent' } });
  assert.ok(store.readFirefliesStore('notified').x);
  writeFileSync(store.firefliesStorePath('notified'), JSON.stringify({ y: { state: 'sent' }, z: { state: 'failed' } }), 'utf8');
  store.resetFirefliesStoreForTests();
  assert.deepEqual(Object.keys(store.readFirefliesStore('notified')).sort(), ['y', 'z']);
});

test('records differ only in more than their bookkeeping stamps', () => {
  const base = { meetingId: 'a', title: 'Møte', at: '2026-10-23T08:00:00.000Z', nested: { b: 1, a: 2 } };
  assert.equal(store.storeRecordsDiffer(base, { ...base, at: '2026-10-23T09:00:00.000Z', updatedAt: 'x' }), false);
  assert.equal(store.storeRecordsDiffer(base, { ...base, nested: { a: 2, b: 1 } }), false, 'key order does not matter');
  assert.equal(store.storeRecordsDiffer(base, { ...base, title: 'Annet' }), true);
  assert.equal(store.storeRecordsDiffer(base, { ...base, listedAt: 'now' }, ['at', 'updatedAt', 'listedAt']), false);
});
