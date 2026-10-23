// The Fireflies pull ingest: the list fast path and the paged catch-up scan, which ids get a
// full fetch, "try later" errors that never count against a meeting, and the ingest health.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-ff-ingest-'));
process.env.APP_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const ff = await import('../lib/fireflies-webhook.js');
const ingest = await import('../lib/fireflies-ingest.js');
const store = await import('../lib/fireflies-store.js');
const { FirefliesApiError } = await import('../lib/fireflies-graphql.js');
const { SafeModeBlockedError } = await import('../lib/safe-mode.js');

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const T0 = Date.parse('2026-10-23T12:00:00.000Z');
const quiet = { log() {}, warn() {} };

function listRow(id, startMs, status = 'processed') {
  return {
    id,
    title: `Testfirma ${id}`,
    dateString: new Date(startMs).toISOString(),
    duration: 30,
    meeting_link: `https://meet.google.com/abc-${id.slice(-4).toLowerCase()}-hij`,
    is_live: false,
    meeting_info: { summary_status: status },
  };
}

/** Fireflies' transcripts list over `rows` (newest first), honouring limit, skip and fromDate. */
function fakeList(rows) {
  const calls = [];
  const list = async ({ limit = 15, skip = 0, fromDate } = {}) => {
    calls.push({ limit, skip, fromDate });
    const from = fromDate === undefined || fromDate === '' ? -Infinity : Number(fromDate);
    return rows.filter((row) => Date.parse(row.dateString) >= from).slice(skip, skip + limit).map((row) => ({ ...row }));
  };
  return { calls, list };
}

function clearIngestState() {
  store.updateFirefliesStore('ingest', (state) => {
    for (const key of Object.keys(state)) delete state[key];
    return true;
  }, { backups: false });
}

const ROWS = Array.from({ length: 120 }, (_, i) => listRow(`FFL${String(i).padStart(4, '0')}`, T0 - (i + 1) * 10 * MIN));

test('the first run pages back 14 days; later scans stop at a page of known, unchanged rows', async () => {
  const fake = fakeList(ROWS);
  const first = await ingest.ingestFirefliesTranscriptList({ apiKey: 'fake-key', listTranscripts: fake.list, nowMs: T0, log: quiet });
  assert.equal(first.newIds.length, 20, 'fast page');
  assert.equal(fake.calls[0].limit, ingest.INGEST_FAST_LIMIT);
  // The fast page held nothing known: the scan runs at once, from 14 days back.
  assert.equal(fake.calls[1].fromDate, T0 - 14 * DAY);
  assert.deepEqual(fake.calls.slice(1).map((call) => [call.limit, call.skip]), [[50, 0], [50, 50], [50, 100]]);
  assert.equal(first.scan.pages, 3);
  assert.equal(first.scan.complete, true);
  assert.equal(ff.listStoredFirefliesMeetings().length, 120);
  assert.equal(ingest.readFirefliesIngestState().lastIngestOkAt, new Date(T0).toISOString());

  // A minute later: the fast page only, and nothing to write.
  const writes = store.firefliesStoreHealth().meetings.writes;
  const second = await ingest.ingestFirefliesTranscriptList({ apiKey: 'fake-key', listTranscripts: fake.list, nowMs: T0 + MIN, log: quiet });
  assert.equal(fake.calls.length, 5);
  assert.equal(second.scan, null);
  assert.equal(store.firefliesStoreHealth().meetings.writes, writes);

  // Ten minutes on: the scan starts a day before the last good one and stops after one known page.
  const third = await ingest.ingestFirefliesTranscriptList({ apiKey: 'fake-key', listTranscripts: fake.list, nowMs: T0 + 11 * MIN, log: quiet });
  assert.equal(fake.calls[6].fromDate, T0 - DAY);
  assert.equal(third.scan.pages, 1);
  assert.equal(third.scan.complete, true);
});

test('meetings that arrived during an outage longer than one page are caught up', async () => {
  const outageEnd = T0 + 3 * DAY;
  const fresh = Array.from({ length: 25 }, (_, i) => listRow(`FFN${String(i).padStart(4, '0')}`, outageEnd - (i + 1) * 30 * MIN));
  const fake = fakeList([...fresh, ...ROWS]);
  const result = await ingest.ingestFirefliesTranscriptList({ apiKey: 'fake-key', listTranscripts: fake.list, nowMs: outageEnd, log: quiet });
  assert.equal(result.newIds.length, 20);
  assert.equal(result.scan.newIds.length, 5, 'the five beyond the fast page');
  assert.deepEqual(fake.calls.slice(1).map((call) => call.skip), [0, 50], 'stops at the first page of known rows');
  for (const row of fresh) assert.ok(ff.readStoredFirefliesMeeting(row.id), row.id);
});

test('a listed status change queues one full fetch; a failing scan waits ten minutes', async () => {
  const id = 'FFQ00001';
  const rows = [listRow(id, T0 + 4 * DAY, 'processing'), ...ROWS];
  const fake = fakeList(rows);
  const nowMs = T0 + 4 * DAY + 60 * MIN;
  await ingest.ingestFirefliesTranscriptList({ apiKey: 'fake-key', listTranscripts: fake.list, nowMs, log: quiet });
  rows[0].meeting_info = { summary_status: 'processed' };
  const changed = await ingest.ingestFirefliesTranscriptList({ apiKey: 'fake-key', listTranscripts: fake.list, nowMs: nowMs + MIN, log: quiet });
  assert.deepEqual(changed.queuedIds, [id]);
  assert.ok(ff.readStoredFirefliesMeeting(id).fetch.queuedAt);

  let scans = 0;
  const failingScan = async (args) => {
    if (args.skip !== undefined) {
      scans += 1;
      throw new FirefliesApiError('Fireflies did not answer within 15 s.', { code: 'timeout' });
    }
    return fake.list(args);
  };
  const later = nowMs + 30 * MIN;
  const result = await ingest.ingestFirefliesTranscriptList({ apiKey: 'fake-key', listTranscripts: failingScan, nowMs: later, log: quiet });
  assert.equal(result.listed, 20, 'the fast page still counts');
  assert.equal(scans, 1);
  await ingest.ingestFirefliesTranscriptList({ apiKey: 'fake-key', listTranscripts: failingScan, nowMs: later + MIN, log: quiet });
  assert.equal(scans, 1, 'not again the next minute');
  await ingest.ingestFirefliesTranscriptList({ apiKey: 'fake-key', listTranscripts: failingScan, nowMs: later + 10 * MIN, log: quiet });
  assert.equal(scans, 2);
});

test('a transcript processing at the first fetch gets its summary at the next one, then never again', async () => {
  const id = 'FFE2E0001';
  const startMs = T0 + 5 * DAY;
  const rows = [listRow(id, startMs, 'processing')];
  const fake = fakeList(rows);
  const answer = (status) => ({
    ...listRow(id, startMs, status),
    sentences: [{ speaker_name: 'Kari Test', text: 'Vi vil ha en nettbutikk.' }],
    summary: status === 'processed' ? { overview: 'Kunden vil ha nettbutikk.', action_items: '- Send tilbud' } : {},
  });
  let reply = answer('processing');
  const fetches = [];
  const hydrate = (nowMs) => (meetingId) => ingest.hydrateFirefliesTranscript(meetingId, {
    apiKey: 'fake-key',
    nowMs,
    fetchTranscript: async (fetchId) => {
      fetches.push(fetchId);
      return reply;
    },
  });
  const linked = [];
  const tick = async (nowMs) => {
    await ingest.ingestFirefliesTranscriptList({ apiKey: 'fake-key', listTranscripts: fake.list, nowMs, log: quiet });
    const plan = ingest.planFirefliesHydration({ storedRows: [ff.readStoredFirefliesMeeting(id)], nowMs });
    return ingest.runFirefliesHydration(plan.fetch, { hydrate: hydrate(nowMs), onFetched: (record) => linked.push(record.summary), log: quiet });
  };
  const t = startMs + 50 * MIN;
  await tick(t);
  assert.deepEqual(fetches, [id]);
  assert.equal(ff.readStoredFirefliesMeeting(id).summary, '');
  assert.match(ff.readStoredFirefliesMeeting(id).transcript, /nettbutikk/, 'the talk is linked at once');
  await tick(t + MIN);
  assert.equal(fetches.length, 1, 'still processing and paused: no fetch');
  rows[0].meeting_info = { summary_status: 'processed' };
  reply = answer('processed');
  await tick(t + 2 * MIN);
  assert.equal(fetches.length, 2, 'the list showed processed: fetched at once');
  assert.equal(linked.at(-1), 'Kunden vil ha nettbutikk.', 'the client link gets the summary');
  for (const later of [3, 30, 600]) await tick(t + later * MIN);
  assert.equal(fetches.length, 2, 'final: never fetched again');
});

test('the plan fetches the longest-waiting ids, including card ids never stored, and relinks stale cards', () => {
  const nowMs = T0;
  const storedRows = [
    { meetingId: 'due-a', title: 'A', firstSeenAt: new Date(nowMs - 30 * MIN).toISOString(), summaryStatus: 'processing' },
    { meetingId: 'final-b', title: 'B', transcript: 'Kari Test: hei', summary: 'Kort.', summaryStatus: 'processed' },
    { meetingId: 'paused-c', title: 'C', summaryStatus: 'processing', fetch: { attempts: 1, nextFetchAt: new Date(nowMs + MIN).toISOString() } },
  ];
  const byId = new Map(storedRows.map((row) => [row.meetingId, row]));
  const plan = ingest.planFirefliesHydration({
    storedRows,
    clientRows: [
      { clientId: 'c1', row: { meetingId: 'never-stored' } },
      { clientId: 'c1', row: { meetingId: 'final-b', hasTranscript: false } },
      { clientId: 'c2', row: { meetingId: 'live:c2:1792749600000' } },
      { clientId: 'c1', row: { meetingId: 'due-a' } },
      { clientId: 'c3', row: { meetingId: 'final-b', hasTranscript: true, summary: 'Kort.' } },
    ],
    readStored: (id) => byId.get(id) || null,
    nowMs,
    max: 2,
  });
  assert.deepEqual(plan.fetch, ['never-stored', 'due-a']);
  assert.deepEqual(plan.relink, [{ clientId: 'c1', meetingId: 'final-b' }]);
});

test('a card is stale only when it shows less than the stored copy, compared the way the card keeps it', () => {
  const stored = { transcript: 'Kari Test: hei', summary: `${'a'.repeat(1999)} ${'b'.repeat(50)}`, actionItems: ['Send tilbud'] };
  // The card keeps the summary cut at 2000 characters and trimmed.
  const card = { hasTranscript: true, summary: 'a'.repeat(1999), actionItems: ['Send tilbud'] };
  assert.equal(ingest.clientMeetingRefIsStale(card, stored), false);
  assert.equal(ingest.clientMeetingRefIsStale({ ...card, hasTranscript: false }, stored), true);
  assert.equal(ingest.clientMeetingRefIsStale({ ...card, summary: '' }, stored), true, 'the summary came later');
  assert.equal(ingest.clientMeetingRefIsStale({ ...card, actionItems: [] }, stored), true);
  assert.equal(ingest.clientMeetingRefIsStale({ hasTranscript: false }, { summaryStatus: 'skipped' }), false, 'nothing to show');
});

test('try-later errors never count against a meeting; other failures back off', async () => {
  const limited = await ingest.hydrateFirefliesTranscript('FFLATER1', {
    apiKey: 'fake-key',
    fetchTranscript: async () => { throw new FirefliesApiError('Too many requests.', { code: 'rate-limited', retryAfterMs: 30_000 }); },
  });
  assert.equal(limited.outcome, 'later');
  assert.equal(ff.readStoredFirefliesMeeting('FFLATER1'), null, 'nothing written');
  const blocked = await ingest.hydrateFirefliesTranscript('FFLATER2', {
    apiKey: 'fake-key',
    fetchTranscript: async () => { throw new SafeModeBlockedError('firefliesIngest', 'transcript fetch'); },
  });
  assert.equal(blocked.outcome, 'later');
  const missing = await ingest.hydrateFirefliesTranscript('FFGONE01', {
    apiKey: 'fake-key',
    nowMs: T0,
    fetchTranscript: async () => { throw Object.assign(new Error('Object not found'), { code: 'object_not_found' }); },
  });
  assert.equal(missing.outcome, 'failed');
  assert.equal(ff.readStoredFirefliesMeeting('FFGONE01').fetch.attempts, 1);

  const seen = [];
  const summary = await ingest.runFirefliesHydration(['ok-1', 'later-2', 'never-3'], {
    hydrate: async (id) => {
      seen.push(id);
      if (id === 'later-2') return { outcome: 'later', error: new Error('rate limited') };
      return { outcome: 'fetched', record: { meetingId: id } };
    },
    onFetched: () => { throw new Error('client write failed'); },
    log: quiet,
  });
  assert.deepEqual(seen, ['ok-1', 'later-2'], 'a try-later answer ends the step for this tick');
  assert.deepEqual(summary.fetched, ['ok-1'], 'a link error does not undo the fetch');
});

test('each tick step runs on its own; only real list failures count, rate limits do not', async () => {
  ingest.resetFirefliesIngestForTests();
  clearIngestState();
  const ran = [];
  const network = new FirefliesApiError('Fireflies request failed: ECONNRESET', { code: 'network' });
  await ingest.runFirefliesIngestTick([
    ['list', async () => { throw network; }],
    ['hydrate', async () => { throw new Error('bad client record'); }],
    ['follow-up', async () => { ran.push('follow-up'); }],
  ], { nowMs: T0, log: quiet });
  assert.deepEqual(ran, ['follow-up'], 'a failing step does not stop the next one');
  let status = ingest.firefliesIngestStatus({ nowMs: T0, env: { FIREFLIES_API_KEY: 'fake-key' } });
  assert.equal(status.consecutiveFailures, 1);
  assert.match(status.lastError, /ECONNRESET/);
  assert.equal(status.steps.hydrate.ok, false);

  await ingest.runFirefliesIngestTick([['list', async () => { throw new FirefliesApiError('Too many requests.', { code: 'rate-limited' }); }]], { nowMs: T0 + MIN, log: quiet });
  status = ingest.firefliesIngestStatus({ nowMs: T0 + MIN, env: { FIREFLIES_API_KEY: 'fake-key' } });
  assert.equal(status.consecutiveFailures, 1, 'a rate-limit pause is not a failure');
  assert.ok(status.lastRateLimitedAt);

  await ingest.runFirefliesIngestTick([['list', async () => ({ listed: 3 })]], { nowMs: T0 + 2 * MIN, log: quiet });
  status = ingest.firefliesIngestStatus({ nowMs: T0 + 2 * MIN, env: { FIREFLIES_API_KEY: 'fake-key' } });
  assert.equal(status.consecutiveFailures, 0);
  assert.equal(status.lastOkAt, new Date(T0 + 2 * MIN).toISOString());
  assert.equal(status.keyConfigured, true);
  assert.equal(status.safeModeBlocked, false);
  assert.ok(Number.isFinite(status.pendingHydrations));
  assert.ok(status.rateLimit && status.store.meetings);

  await ingest.runFirefliesIngestTick([['watchdog', async () => ({ health: { missingPlaceholders: 2 } })]], { nowMs: T0 + 3 * MIN, log: quiet });
  assert.equal(ingest.firefliesIngestStatus({ env: {} }).missingPlaceholders, 2);
});

test('the owner hears once per 12 hours when the pull keeps failing or has not worked for 30 minutes', async () => {
  ingest.resetFirefliesIngestForTests();
  clearIngestState();
  const env = { FIREFLIES_API_KEY: 'fake-key' };
  const sent = [];
  const sendEmail = async (message) => { sent.push(message); };
  const failing = () => [['list', async () => { throw new FirefliesApiError('HTTP 401', { code: 'http', status: 401 }); }]];
  let now = T0;
  for (let i = 0; i < 10; i += 1) {
    await ingest.runFirefliesIngestTick(failing(), { nowMs: now, log: quiet });
    now += 30 * 1000;
  }
  assert.equal(await ingest.maybeAlertFirefliesIngest({ sendEmail, nowMs: now, env, log: quiet }), null, 'ten failures in five minutes: not yet');
  await ingest.runFirefliesIngestTick(failing(), { nowMs: now, log: quiet });
  const first = await ingest.maybeAlertFirefliesIngest({ sendEmail, nowMs: now, env, log: quiet });
  assert.equal(first.reason, 'failures');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'damian@asoldi.com');
  assert.equal(sent[0].subject, 'Fireflies: opptak hentes ikke inn');
  assert.match(sent[0].text, /Feil på rad: 11/);
  assert.match(sent[0].text, /HTTP 401/);
  assert.equal(await ingest.maybeAlertFirefliesIngest({ sendEmail, nowMs: now + 60 * MIN, env, log: quiet }), null, 'once per 12 hours');
  assert.equal(sent.length, 1);

  // A success, then nothing good for over 30 minutes (rate limits only) and 12 hours since the last alert.
  await ingest.runFirefliesIngestTick([['list', async () => ({ listed: 1 })]], { nowMs: now + 12 * 60 * MIN, log: quiet });
  const stale = await ingest.maybeAlertFirefliesIngest({ sendEmail, nowMs: now + 12 * 60 * MIN + 31 * MIN, env, log: quiet });
  assert.equal(stale.reason, 'stale');
  assert.equal(sent.length, 2);
  assert.equal(await ingest.maybeAlertFirefliesIngest({ sendEmail, nowMs: now + 30 * 60 * MIN, env: {}, log: quiet }), null, 'no key: nothing to alert about');
});

test('a keyed backoff doubles while nothing changes and ends when the input changes', () => {
  const backoff = ingest.createKeyedBackoff({ baseMs: 10 * MIN, maxMs: 30 * MIN });
  assert.equal(backoff.due('c1', 'f1', T0), true);
  backoff.idle('c1', 'f1', T0);
  assert.equal(backoff.due('c1', 'f1', T0 + 9 * MIN), false);
  assert.equal(backoff.due('c1', 'f1', T0 + 10 * MIN), true);
  backoff.idle('c1', 'f1', T0 + 10 * MIN);
  assert.equal(backoff.due('c1', 'f1', T0 + 29 * MIN), false, 'twenty minutes the second time');
  assert.equal(backoff.due('c1', 'f2', T0 + 11 * MIN), true, 'new recordings or a changed offer: at once');
  backoff.idle('c1', 'f1', T0 + 30 * MIN);
  backoff.idle('c1', 'f1', T0 + 60 * MIN);
  assert.equal(backoff.due('c1', 'f1', T0 + 89 * MIN), false);
  assert.equal(backoff.due('c1', 'f1', T0 + 90 * MIN), true, 'capped at maxMs');
});
