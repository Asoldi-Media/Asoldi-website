// The decision log (lib/ops-events.js) and the two reports built on it (lib/ops-reports.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-ops-reports-'));
process.env.APP_DATA_DIR = dataDir;

const { OPS_EVENTS_KEEP_DAYS, opsEventsDir, readOpsEvents, recordOpsEvent } = await import('../lib/ops-events.js');
const { firefliesReport, inboxBotReport, percentile, readAiLedgerRows } = await import('../lib/ops-reports.js');

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const NOW = Date.parse('2031-03-07T12:00:00.000Z');
const MIN = 60000;
const iso = (ms) => new Date(ms).toISOString();

test('the log keeps ids, reasons and timings, never a mail body or a secret, and never throws', () => {
  const row = recordOpsEvent('inbox', 'mail.decided', {
    salesClientId: 'card-1',
    text: 'Hei, jeg kan ikke komme',
    replyText: 'Helt i orden',
    password: 'x',
    reason: 'r'.repeat(500),
    nested: { body: 'drop', ok: true },
  }, { nowMs: NOW });
  assert.equal(row.salesClientId, 'card-1');
  assert.equal('text' in row || 'replyText' in row || 'password' in row, false);
  assert.equal(row.nested.ok, true);
  assert.equal('body' in row.nested, false);
  assert.ok(row.reason.length <= 301);
  const stored = readFileSync(join(opsEventsDir(), '2031-03.jsonl'), 'utf8');
  assert.doesNotMatch(stored, /kan ikke komme|Helt i orden/);
  assert.deepEqual(readOpsEvents({ system: 'inbox', sinceMs: NOW - MIN, untilMs: NOW + MIN }).map((r) => r.type), ['mail.decided']);
  assert.deepEqual(readOpsEvents({ system: 'fireflies', sinceMs: NOW - MIN, untilMs: NOW + MIN }), []);
});

test('month files older than the keep window are pruned on the first write of a new month', () => {
  mkdirSync(opsEventsDir(), { recursive: true });
  writeFileSync(join(opsEventsDir(), '2030-10.jsonl'), '{"at":"2030-10-01T00:00:00.000Z","system":"inbox","type":"old"}\n');
  writeFileSync(join(opsEventsDir(), '2031-02.jsonl'), '{"at":"2031-02-01T00:00:00.000Z","system":"inbox","type":"recent"}\n');
  recordOpsEvent('fireflies', 'look', { ok: true }, { nowMs: Date.parse('2031-04-02T08:00:00.000Z') });
  assert.equal(OPS_EVENTS_KEEP_DAYS, 90);
  assert.equal(existsSync(join(opsEventsDir(), '2030-10.jsonl')), false);
  assert.equal(existsSync(join(opsEventsDir(), '2031-02.jsonl')), true);
});

test('percentile is nearest-rank and ignores gaps', () => {
  assert.equal(percentile([5, 1, 3, NaN, 4, 2], 50), 3);
  assert.equal(percentile([5, 1, 3, 4, 2], 90), 5);
  assert.equal(percentile([], 50), null);
});

test('inbox report: outcomes, answer times, failures, disagreements, AI cost and a review list per mail', () => {
  const mail = (n, extra) => ({
    id: `i${n}`,
    messageId: `imap:alexander@asoldi.com:uid:${n}:write`,
    salesClientId: 'card-1',
    receivedAt: iso(NOW - n * 60 * MIN),
    subject: `Re: møte ${n}`,
    text: `Kunden skrev ${n}`,
    ...extra,
  });
  const items = [
    mail(1, { kind: 'sales_cancel', status: 'applied', replyText: 'Helt i orden, vi finner en ny tid.', repliedAt: iso(NOW - 60 * MIN + 40000) }),
    mail(2, { kind: 'sales_book', status: 'applied', replyText: 'Det passer fint.', repliedAt: iso(NOW - 120 * MIN + 90000) }),
    mail(3, { kind: 'silent', status: 'needs_human', reason: 'ai-disagrees:info' }),
    mail(4, { kind: 'sales_propose', status: 'needs_human', reason: 'reply-failed' }),
    mail(5, { kind: 'none', status: 'logged', reason: 'meeting-echo' }),
    { ...mail(6, { kind: 'bounce', status: 'logged', reason: 'bounce:post@firma.test' }), messageId: 'x:bounce' },
    { ...mail(7, {}), messageId: 'imap:alexander@asoldi.com:uid:7', kind: 'other', status: 'unmatched' },
    mail(24 * 9, { kind: 'sales_book', status: 'applied' }),
  ];
  const events = [
    { at: iso(NOW - 59 * MIN), type: 'mail.decided', messageId: 'imap:alexander@asoldi.com:uid:1', words: 'cancel', ai: 'reschedule_day', lagMs: 30000 },
    { at: iso(NOW - 119 * MIN), type: 'mail.decided', messageId: 'imap:alexander@asoldi.com:uid:2', words: 'reschedule', ai: 'reschedule', lagMs: 80000 },
    { at: iso(NOW - 50 * MIN), type: 'copy.appended', sent: { ok: true }, inbox: { ok: false } },
    { at: iso(NOW - 50 * MIN), type: 'reply.sent', ok: false },
    { at: iso(NOW - 50 * MIN), type: 'tick', ms: 900 },
  ];
  const ledgerRows = [
    { at: iso(NOW - 60 * MIN), task: 'inbox.decide', usd: 0.002 },
    { at: iso(NOW - 60 * MIN), task: 'inbox.categorize', usd: 0.001 },
    { at: iso(NOW - 60 * MIN), task: 'offer.reflect-contract', usd: 0.5 },
  ];
  const report = inboxBotReport({ days: 7, nowMs: NOW, items, events, clients: [{ id: 'card-1', businessName: 'Firma AS' }], ledgerRows });
  assert.equal(report.mails, 6, 'only decided client mails and card events in the window');
  assert.deepEqual(report.outcome, { answered: 2, forPerson: 2, noReplyNeeded: 2, skipped: 0 });
  assert.deepEqual(report.byAction, { sales_cancel: 1, sales_book: 1 });
  assert.deepEqual(report.forPersonByReason, { 'ai-disagrees': 1, 'reply-failed': 1 });
  assert.equal(report.latency.replyMedianMs, 40000);
  assert.equal(report.latency.replyP90Ms, 90000);
  assert.equal(report.aiDisagrees, 1);
  assert.equal(report.failures['reply-failed'], 1);
  assert.equal(report.failures.inboxCopyFailed, 1);
  assert.equal(report.failures.replySendErrors, 1);
  assert.deepEqual([report.ai.calls, report.ai.usd], [2, 0.003]);
  const first = report.review.find((row) => row.subject === 'Re: møte 1');
  assert.deepEqual([first.words, first.ai, first.action, first.businessName], ['cancel', 'reschedule_day', 'sales_cancel', 'Firma AS']);
  assert.match(first.replyText, /ny tid/);
});

test('fireflies report: recorded rate, time to bot in, sends, the room window and co-hosts', () => {
  const start = NOW - 3 * 60 * MIN;
  const session = (key, extra) => ({ key, startAt: iso(start), bookedMinutes: 60, slots: [{ clientId: 'c1' }], attempts: [{ at: iso(start - 3 * MIN), ok: true }], state: 'ended', ...extra });
  const sessions = {
    a: session('a', { firstSeenActiveAt: iso(start - 2 * MIN), ffMeetingIds: ['ff1'], meetWindowState: 'locked' }),
    b: { ...session('b', { slots: [{ clientId: 'c2' }], attempts: [{ ok: true }, { ok: false, rateLimited: true }, { ok: true }] }), state: 'not-admitted' },
    c: session('c', { declinedAt: iso(start), slots: [{ clientId: 'c3' }] }),
  };
  const clients = [
    { id: 'c1', meetings: [{ meetingId: 'ff1', startedAt: iso(start - MIN), hasTranscript: true }] },
    { id: 'c2', meetings: [] },
    { id: 'c3', meetings: [] },
  ];
  const events = [
    { at: iso(start - 5 * MIN), type: 'room.access', access: 'OPEN', ok: true },
    { at: iso(start - 2 * MIN), type: 'room.access', access: 'TRUSTED', ok: true },
    { at: iso(start - 5 * MIN), type: 'room.access', access: 'OPEN', ok: false, reason: 'scope-missing' },
    { at: iso(start - 60 * MIN), type: 'room.prepared', via: 'meet-api', cohostsOk: true },
    { at: iso(start - 60 * MIN), type: 'room.prepared', via: 'calendar', reason: 'scope-missing' },
    { at: iso(start - 3 * MIN), type: 'bot.sent', ok: true },
    { at: iso(start - 2 * MIN), type: 'look', ok: true },
    { at: iso(start), type: 'notetaker.foreign', mailbox: 'alexander@asoldi.com', tool: 'Fathom' },
  ];
  const report = firefliesReport({ days: 7, nowMs: NOW, clients, sessions, events, missingRows: [{ startedAt: iso(start), state: 'not-admitted' }] });
  assert.deepEqual([report.meetings, report.recorded, report.recordedRate, report.declined], [2, 1, 0.5, 1]);
  assert.deepEqual([report.botInByT3, report.botInMedianMinutes], [1, -2]);
  assert.equal(report.sends.rateLimited, 1);
  assert.deepEqual(report.roomWindow, { opened: 1, openFailed: 1, locked: 1, lockFailed: 0, failReasons: { 'scope-missing': 1 } });
  assert.deepEqual(report.roomsMade, { byHub: 1, cohostsOk: 1, byCalendar: 1, calendarReasons: { 'scope-missing': 1 } });
  assert.deepEqual(report.missing, { total: 1, byState: { 'not-admitted': 1 } });
  assert.deepEqual(report.foreignNotetakers, { 'alexander@asoldi.com Fathom': 1 });
});

test('the AI ledger rows of the window are read from the ledger files', () => {
  mkdirSync(join(dataDir, 'ai'), { recursive: true });
  writeFileSync(join(dataDir, 'ai', '2031-03.jsonl'), 'not a ledger file\n');
  writeFileSync(join(dataDir, 'ai', 'ledger-2031-03.jsonl'), [
    JSON.stringify({ v: 2, kind: 'llm', at: iso(NOW - MIN), task: 'inbox.decide', usd: 0.001 }),
    '{ torn',
    JSON.stringify({ v: 2, kind: 'llm', at: iso(NOW - 30 * 86400000), task: 'inbox.decide', usd: 0.009 }),
  ].join('\n'));
  const rows = readAiLedgerRows({ sinceMs: NOW - 86400000, dataDir });
  assert.deepEqual(rows.map((row) => row.task), ['inbox.decide']);
});
