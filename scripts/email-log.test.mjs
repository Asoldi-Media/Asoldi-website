import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-email-log-'));
process.env.APP_DATA_DIR = dataDir;

const {
  createEmailLog,
  hashEmail,
  maskEmail,
  monthKey,
  sanitizeMessageRow,
} = await import('../lib/email-log.js');

const NOW = Date.parse('2026-10-23T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
let dirCount = 0;
function freshDir() {
  dirCount += 1;
  return join(dataDir, `log-${dirCount}`);
}

test('WS7.1: message lines are whitelisted and carry no plain recipient', () => {
  const dir = freshDir();
  const log = createEmailLog({ dir, now: () => NOW, flushMs: 0 });
  const row = log.appendMessage({
    siteId: 'site_a',
    kind: 'cart-recovery',
    cls: 'p1',
    ref: 'int_1',
    step: 1,
    dedupeKey: 'site_a:cart-recovery:int_1:1',
    to: { email: 'Ola@Example.no', name: 'Ola' },
    html: '<p>secret body</p>',
    consent: { basis: 'explicit', scope: 'cartReminder', grade: 'checkout', textHash: 'sha256:ab', at: 'x', ip: '1.2.3.4' },
    provider: 'brevo',
    status: 'accepted',
  });
  assert.match(row.id, /^em_[0-9A-Z]+$/);
  assert.equal(row.toHash, hashEmail('ola@example.no'));
  assert.equal(row.toMasked, 'o***@example.no');
  assert.deepEqual(row.consent, { basis: 'explicit', scope: 'cartReminder', grade: 'checkout', textHash: 'sha256:ab' });
  const files = readdirSync(dir);
  assert.deepEqual(files, [`messages-${monthKey(NOW)}.jsonl`]);
  const body = readFileSync(join(dir, files[0]), 'utf8');
  assert.equal(body.includes('Ola@Example.no') || body.includes('ola@example.no'), false);
  assert.equal(body.includes('secret body'), false);
  assert.equal(body.includes('1.2.3.4'), false);
  assert.throws(() => log.appendMessage({ kind: 'test' }), /siteId and kind/);
  assert.equal(maskEmail('x'), '***');
  assert.equal(sanitizeMessageRow({ siteId: 's', kind: 'k', status: 'weird' }).status, 'accepted');
});

test('WS7.1: dedupe keys are visible right after the append, failed sends do not dedupe', () => {
  const log = createEmailLog({ dir: freshDir(), now: () => NOW, flushMs: 0 });
  log.appendMessage({ siteId: 's', kind: 'welcome', dedupeKey: 's:welcome:c1:0', status: 'accepted' });
  log.appendMessage({ siteId: 's', kind: 'welcome', dedupeKey: 's:welcome:c2:0', status: 'failed' });
  assert.equal(log.hasDedupeKey('s:welcome:c1:0'), true);
  assert.equal(log.hasDedupeKey('s:welcome:c2:0'), false);
  assert.equal(log.hasDedupeKey(''), false);
});

test('WS7.1: a second instance on the same dir (another worker) sees appended lines', () => {
  const dir = freshDir();
  const a = createEmailLog({ dir, now: () => NOW, flushMs: 0 });
  const b = createEmailLog({ dir, now: () => NOW, flushMs: 0 });
  assert.equal(b.hasDedupeKey('s:test:r:1'), false);
  a.appendMessage({ siteId: 's', kind: 'test', ref: 'r', step: 1, dedupeKey: 's:test:r:1' });
  assert.equal(b.hasDedupeKey('s:test:r:1'), true);
  assert.equal(b.siteTotals('s').sent, 1);
});

test('WS7.1: a torn last line is skipped until it is complete', () => {
  const dir = freshDir();
  const log = createEmailLog({ dir, now: () => NOW, flushMs: 0 });
  log.appendMessage({ siteId: 's', kind: 'test', dedupeKey: 'k1' });
  const file = join(dir, `messages-${monthKey(NOW)}.jsonl`);
  const line = JSON.stringify(sanitizeMessageRow({ siteId: 's', kind: 'test', dedupeKey: 'k2' }, NOW));
  appendFileSync(file, line.slice(0, 20));
  assert.equal(log.hasDedupeKey('k2'), false);
  appendFileSync(file, `${line.slice(20)}\n`);
  assert.equal(log.hasDedupeKey('k2'), true);
  appendFileSync(file, 'not json\n');
  assert.equal(log.hasDedupeKey('k1'), true, 'junk lines are ignored');
});

test('WS7.1: events queue in memory and flush in one append; opens count once per message', () => {
  const dir = freshDir();
  const log = createEmailLog({ dir, now: () => NOW, flushMs: 0 });
  const message = log.appendMessage({ siteId: 's', kind: 'campaign', ref: 'cmp_1', campaignId: 'hc_1' });
  for (let i = 0; i < 300; i += 1) log.appendEvent({ messageId: message.id, t: i % 3 === 0 ? 'opened' : 'delivered', siteId: 's' });
  assert.equal(log.appendEvent({ messageId: message.id, t: 'not-an-event' }), null);
  const eventsFile = join(dir, `events-${monthKey(NOW)}.jsonl`);
  assert.equal(existsSync(eventsFile), false, 'nothing written before the flush');
  assert.equal(log.pendingEvents(), 300);
  assert.equal(log.flushEvents(), 300);
  assert.equal(readFileSync(eventsFile, 'utf8').trim().split('\n').length, 300);
  const stats = log.statsFor({ siteId: 's', campaignId: 'hc_1' });
  assert.deepEqual(stats.totals, { sent: 1, delivered: 1, opened: 1, clicked: 0, bounced: 0, unsubscribed: 0, complaints: 0, blocked: 0 });
  assert.equal(stats.byRef.cmp_1.opened, 1);
  assert.equal(log.flushEvents(), 0);
});

test('WS7.1: the flush timer writes queued events on its own', async () => {
  const dir = freshDir();
  const log = createEmailLog({ dir, now: () => NOW, flushMs: 30 });
  const message = log.appendMessage({ siteId: 's', kind: 'test' });
  log.appendEvent({ messageId: message.id, t: 'click' });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(log.pendingEvents(), 0);
  assert.equal(log.siteTotals('s').clicked, 1);
  log.stop();
});

test('WS7.1 (e): rebuilding from 4 monthly files with 20 000 messages takes < 2 s and restores the dedupe set exactly', () => {
  const dir = freshDir();
  createEmailLog({ dir, now: () => NOW, flushMs: 0 }).readIndex();
  const months = ['2026-07', '2026-08', '2026-09', '2026-10'];
  const expected = new Set();
  const cutoff = NOW - 90 * DAY;
  let n = 0;
  for (const month of months) {
    const lines = [];
    const events = [];
    for (let i = 0; i < 5000; i += 1) {
      n += 1;
      const day = String(1 + (i % 22)).padStart(2, '0');
      const createdAt = `${month}-${day}T08:00:00.000Z`;
      const id = `em_${n}`;
      const dedupeKey = `site_${n % 7}:cart-recovery:int_${n}:1`;
      const status = n % 50 === 0 ? 'failed' : 'accepted';
      lines.push(JSON.stringify({ id, siteId: `site_${n % 7}`, kind: 'cart-recovery', ref: `int_${n}`, step: 1, dedupeKey, status, createdAt }));
      if (n % 4 === 0) events.push(JSON.stringify({ messageId: id, t: 'delivered', at: createdAt }));
      if (status !== 'failed' && Date.parse(createdAt) >= cutoff) expected.add(dedupeKey);
    }
    const key = month.replace('-', '');
    writeFileSync(join(dir, `messages-${key}.jsonl`), `${lines.join('\n')}\n`);
    writeFileSync(join(dir, `events-${key}.jsonl`), `${events.join('\n')}\n`);
  }
  const log = createEmailLog({ dir, now: () => NOW, flushMs: 0 });
  const started = process.hrtime.bigint();
  const index = log.rebuildIndex();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 2000, `rebuild took ${ms.toFixed(0)} ms`);
  assert.equal(index.messages.size, 20000);
  assert.ok(expected.size > 10000 && expected.size < 20000, 'the window cuts some July sends');
  assert.equal(index.dedupe.size, expected.size);
  for (const key of expected) assert.equal(index.dedupe.has(key), true);
  const delivered = [...index.sites.values()].reduce((sum, row) => sum + row.delivered, 0);
  assert.equal(delivered, 5000);
});

test('WS7.1: pruning rolls up months outside the index and deletes files older than 13 months', () => {
  const dir = freshDir();
  createEmailLog({ dir, now: () => NOW, flushMs: 0 }).readIndex();
  const write = (month, rows) => writeFileSync(join(dir, `messages-${month}.jsonl`), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  write('202508', [{ id: 'old1', siteId: 's', kind: 'k', createdAt: '2025-08-02T00:00:00.000Z' }]);
  write('202509', [{ id: 'old2', siteId: 's', kind: 'k', createdAt: '2025-09-02T00:00:00.000Z' }]);
  write('202604', [
    { id: 'mid1', siteId: 's', kind: 'k', createdAt: '2026-04-02T00:00:00.000Z' },
    { id: 'mid2', siteId: 't', kind: 'k', createdAt: '2026-04-03T00:00:00.000Z' },
  ]);
  writeFileSync(join(dir, 'events-202604.jsonl'), `${JSON.stringify({ messageId: 'mid1', t: 'spam', at: '2026-04-05T00:00:00.000Z' })}\n`);
  write('202610', [{ id: 'now1', siteId: 's', kind: 'k', createdAt: '2026-10-02T00:00:00.000Z' }]);
  const log = createEmailLog({ dir, now: () => NOW, flushMs: 0 });
  const result = log.pruneLogs(NOW);
  const left = readdirSync(dir).sort();
  assert.equal(left.includes('messages-202508.jsonl'), false, '14 months old: deleted');
  assert.equal(left.includes('messages-202509.jsonl'), false, '13 months back is outside the keep window');
  assert.equal(left.includes('messages-202604.jsonl'), true);
  assert.equal(left.includes('messages-202610.jsonl'), true);
  assert.equal(result.removed, 2);
  const rollups = log.readRollups();
  assert.equal(rollups.months['202604'].sites.s.sent, 1);
  assert.equal(rollups.months['202604'].sites.s.complaints, 1);
  assert.equal(rollups.months['202604'].sites.t.sent, 1);
  assert.equal(rollups.months['202508'].messages, 1, 'old months keep their rollup after deletion');
  assert.equal(rollups.months['202610'], undefined, 'indexed months are not rolled up');
  assert.equal(log.pruneLogs(NOW).rolledUp, 0, 'idempotent');
});

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});
