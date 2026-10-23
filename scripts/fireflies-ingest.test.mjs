// The Fireflies pull ingest: the list fast path and the paged catch-up scan, which ids get a
// full fetch, "try later" errors that never count against a meeting, and the ingest health.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

test('the alert stamp is kept in memory too, so a stamp that never reached the disk sends no second e-mail', async () => {
  ingest.resetFirefliesIngestForTests();
  clearIngestState();
  const env = { FIREFLIES_API_KEY: 'fake-key' };
  const sent = [];
  const sendEmail = async (message) => { sent.push(message); };
  for (let i = 0; i < 11; i += 1) {
    await ingest.runFirefliesIngestTick([['list', async () => { throw new FirefliesApiError('HTTP 401', { code: 'http', status: 401 }); }]], { nowMs: T0 + i * MIN, log: quiet });
  }
  assert.equal((await ingest.maybeAlertFirefliesIngest({ sendEmail, nowMs: T0 + 11 * MIN, env, log: quiet })).reason, 'failures');
  clearIngestState();
  for (let i = 1; i <= 5; i += 1) {
    assert.equal(await ingest.maybeAlertFirefliesIngest({ sendEmail, nowMs: T0 + (11 + i) * MIN, env, log: quiet }), null);
  }
  assert.equal(sent.length, 1);
  assert.equal(ingest.firefliesIngestStatus({ nowMs: T0 + 20 * MIN, env }).lastHealthAlertAt, new Date(T0 + 11 * MIN).toISOString());
});

test('an unreadable ingest-state file starts over instead of refusing every write, and alerts once', async () => {
  ingest.resetFirefliesIngestForTests();
  store.resetFirefliesStoreForTests();
  const path = store.firefliesStorePath('ingest');
  writeFileSync(path, '{"lastScanAt":"2026-10-2', 'utf8');
  const env = { FIREFLIES_API_KEY: 'fake-key' };
  let sent = 0;
  let now = T0;
  const errors = console.error;
  console.error = () => {};
  try {
    for (let i = 0; i < 12; i += 1) {
      await ingest.runFirefliesIngestTick([['list', async () => { throw new FirefliesApiError('HTTP 401', { code: 'http', status: 401 }); }]], { nowMs: now, log: quiet });
    }
    for (let i = 0; i < 5; i += 1) {
      now += MIN;
      await ingest.maybeAlertFirefliesIngest({ sendEmail: async () => { sent += 1; }, nowMs: now, env, log: quiet });
    }
  } finally {
    console.error = errors;
  }
  assert.equal(sent, 1, 'one e-mail, not one a minute');
  assert.equal(typeof JSON.parse(readFileSync(path, 'utf8')).lastHealthAlertAt, 'string', 'the file is whole again');
  assert.equal(ingest.firefliesIngestStatus({ nowMs: now, env }).stateError, '');
  assert.ok(readdirSync(join(dataDir, 'backups')).some((name) => name.startsWith('fireflies-ingest-state.json.unreadable-')), 'the bad file is kept');
});

test('a catch-up scan or missing-recording lookups that fail for an hour alert the owner; pauses do not count', async () => {
  ingest.resetFirefliesIngestForTests();
  clearIngestState();
  const env = { FIREFLIES_API_KEY: 'fake-key' };
  const sent = [];
  const sendEmail = async (message) => { sent.push(message); };
  const fake = fakeList(ROWS);
  let scanError = new FirefliesApiError('Fireflies did not answer within 15 s.', { code: 'timeout' });
  const list = async (args) => {
    if (args.skip !== undefined) throw scanError;
    return fake.list(args);
  };
  const tick = (nowMs, watchdogHealth) => ingest.runFirefliesIngestTick([
    ['list', () => ingest.ingestFirefliesTranscriptList({ apiKey: 'fake-key', listTranscripts: list, nowMs, log: quiet })],
    ['watchdog', async () => ({ health: watchdogHealth })],
  ], { nowMs, log: quiet });
  const ok = { missingPlaceholders: 0, lookups: 0, lookupErrors: 0 };
  // Timeouts for an hour and a half: try later, not a broken scan.
  for (let m = 0; m <= 90; m += 10) await tick(T0 + 10 * DAY + m * MIN, ok);
  assert.equal(await ingest.maybeAlertFirefliesIngest({ sendEmail, nowMs: T0 + 10 * DAY + 91 * MIN, env, log: quiet }), null);

  // Fireflies rejects the scan's date window: an hour of that is worth an e-mail.
  scanError = new FirefliesApiError('Variable "$fromDate" got an invalid value.', { code: 'invalid_arguments' });
  const from = T0 + 11 * DAY;
  for (let m = 0; m <= 50; m += 10) await tick(from + m * MIN, ok);
  assert.equal(await ingest.maybeAlertFirefliesIngest({ sendEmail, nowMs: from + 55 * MIN, env, log: quiet }), null, 'not before an hour');
  await tick(from + 61 * MIN, ok);
  const scanAlert = await ingest.maybeAlertFirefliesIngest({ sendEmail, nowMs: from + 61 * MIN, env, log: quiet });
  assert.equal(scanAlert.reason, 'scan-failing');
  assert.equal(sent[0].subject, 'Fireflies: eldre opptak hentes ikke inn');
  assert.match(sent[0].text, /invalid value/);
  let status = ingest.firefliesIngestStatus({ nowMs: from + 61 * MIN, env });
  assert.equal(status.scan.failingSince, new Date(from).toISOString());
  assert.equal(status.consecutiveFailures, 0, 'the fast page kept working');

  // The watchdog's lookups all fail (its step still runs), with the scan healthy again.
  ingest.resetFirefliesIngestForTests();
  clearIngestState();
  scanError = null;
  const healthy = async (args) => fake.list(args);
  const watchTick = (nowMs, counts) => ingest.runFirefliesIngestTick([
    ['list', () => ingest.ingestFirefliesTranscriptList({ apiKey: 'fake-key', listTranscripts: healthy, nowMs, log: quiet })],
    ['watchdog', async () => ({ health: counts })],
  ], { nowMs, log: quiet });
  const failing = { missingPlaceholders: 0, lookups: 2, lookupErrors: 2, lastLookupError: 'Variable "$toDate" got an invalid value.' };
  const at = T0 + 12 * DAY;
  for (let m = 0; m <= 60; m += 10) await watchTick(at + m * MIN, failing);
  await watchTick(at + 62 * MIN, ok);
  assert.ok(ingest.firefliesIngestStatus({ nowMs: at + 62 * MIN, env }).watchdog.failingSince, 'a tick with no lookups changes nothing');
  const watchAlert = await ingest.maybeAlertFirefliesIngest({ sendEmail, nowMs: at + 62 * MIN, env, log: quiet });
  assert.equal(watchAlert.reason, 'watchdog-failing');
  assert.equal(sent.at(-1).subject, 'Fireflies: bookede møter blir ikke sjekket');
  assert.match(sent.at(-1).text, /\$toDate/);
  await watchTick(at + 70 * MIN, { missingPlaceholders: 1, lookups: 2, lookupErrors: 1 });
  status = ingest.firefliesIngestStatus({ nowMs: at + 70 * MIN, env });
  assert.equal(status.watchdog.failingSince, '', 'one lookup that works ends the run');
  assert.equal(status.missingPlaceholders, 1);
});

test('an archive that reads empty while cards hold recordings is told to the owner once each time it happens', async () => {
  ingest.resetFirefliesIngestForTests();
  clearIngestState();
  const env = { FIREFLIES_API_KEY: 'fake-key' };
  const sent = [];
  const sendEmail = async (message) => { sent.push(message); };
  // The server's backfill step reports what it found (server.js ensureFirefliesMeetLinkBackfill).
  const tick = (nowMs, archiveEmpty) => ingest.runFirefliesIngestTick([
    ['list', async () => ({ listed: 1 })],
    ['backfill', async () => ({ scanned: 0, linked: 0, detached: 0, health: { archiveEmpty } })],
  ], { nowMs, log: quiet });
  let now = T0;
  await tick(now, true);
  const first = await ingest.maybeAlertFirefliesIngest({ sendEmail, nowMs: now, env, log: quiet });
  assert.equal(first.reason, 'archive-empty');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, 'Fireflies: arkivet er tomt');
  assert.match(sent[0].text, /flytter og fjerner derfor ingen opptak på kundekortene før arkivet har møter igjen/);
  assert.match(sent[0].text, /én gang hver gang arkivet blir tomt/);
  // Every tick after that (also 13 hours later, and after a restart): no second e-mail for the same state.
  for (const minutes of [1, 2, 3, 13 * 60]) {
    await tick(T0 + minutes * MIN, true);
    assert.equal(await ingest.maybeAlertFirefliesIngest({ sendEmail, nowMs: T0 + minutes * MIN, env, log: quiet }), null);
  }
  ingest.resetFirefliesIngestForTests();
  now = T0 + 14 * 60 * MIN;
  await tick(now, true);
  assert.equal(await ingest.maybeAlertFirefliesIngest({ sendEmail, nowMs: now, env, log: quiet }), null, 'the stamp is on disk');
  assert.equal(sent.length, 1);
  // The archive holds meetings again; the next time it reads empty is a new state, told again.
  await tick(now + MIN, false);
  assert.equal(ingest.firefliesIngestStatus({ nowMs: now + MIN, env }).archiveEmptyAlertAt, '');
  assert.equal(await ingest.maybeAlertFirefliesIngest({ sendEmail, nowMs: now + MIN, env, log: quiet }), null);
  await tick(now + 2 * MIN, true);
  assert.equal((await ingest.maybeAlertFirefliesIngest({ sendEmail, nowMs: now + 2 * MIN, env, log: quiet })).reason, 'archive-empty');
  assert.equal(sent.length, 2);
  // It never takes the 12-hour stamp of the other ingest alerts.
  assert.equal(ingest.firefliesIngestStatus({ nowMs: now + 2 * MIN, env }).lastHealthAlertAt, '');

  // server.js reports it from the backfill step.
  const server = readFileSync(fileURLToPath(new URL('../server.js', import.meta.url)), 'utf8');
  const backfill = server.slice(server.indexOf('function ensureFirefliesMeetLinkBackfill('), server.indexOf('function clientAfterFirefliesBackfill('));
  assert.match(backfill, /health: \{ archiveEmpty: sanitizeText\(plan\.skipped\) === 'empty-store' \},/);
  assert.match(server, /\['backfill', \(\) => ensureFirefliesMeetLinkBackfill\(\{ force: true, archiveLost \}\)\],/);
  // Decided before the list step writes its first page into a lost archive.
  assert.match(server, /const archiveLost = firefliesStoreSource\('meetings'\) === 'missing';\s*\/\/[^\n]*\n\s*await runFirefliesIngestTick\(\[\s*\['list'/);
});

test('an unreadable e-mail list with no backup alerts the owner like an unreadable archive', async () => {
  ingest.resetFirefliesIngestForTests();
  clearIngestState();
  store.resetFirefliesStoreForTests();
  const path = store.firefliesStorePath('notified');
  const backupDir = join(dataDir, 'backups');
  const saved = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const latest = join(backupDir, 'fireflies-notified.json.latest.json');
  const savedLatest = existsSync(latest) ? readFileSync(latest, 'utf8') : null;
  writeFileSync(path, 'not json', 'utf8');
  if (savedLatest !== null) writeFileSync(latest, 'not json either', 'utf8');
  const errors = console.error;
  console.error = () => {};
  try {
    const sent = [];
    await ingest.runFirefliesIngestTick([['list', async () => ({ listed: 1 })]], { nowMs: T0, log: quiet });
    const alert = await ingest.maybeAlertFirefliesIngest({ sendEmail: async (message) => { sent.push(message); }, nowMs: T0, env: { FIREFLIES_API_KEY: 'fake-key' }, log: quiet });
    assert.equal(alert.reason, 'store-unreadable');
    assert.equal(sent[0].subject, 'Fireflies: arkivet kan ikke leses');
    assert.match(sent[0].text, /fireflies-notified\.json/);
  } finally {
    console.error = errors;
    if (saved === null) unlinkSync(path); else writeFileSync(path, saved, 'utf8');
    if (savedLatest !== null) writeFileSync(latest, savedLatest, 'utf8');
    store.resetFirefliesStoreForTests();
  }
});

test('rows the old ingest stored while Fireflies was processing are caught up once, however old', async () => {
  const id = 'FFOLD0001';
  const nowMs = T0 + 30 * DAY;
  ff.updateStoredFirefliesMeeting(id, {
    title: 'Testfirma AS · Kari Test',
    startedAt: new Date(nowMs - 20 * DAY).toISOString(),
    meetingLink: 'https://meet.google.com/abc-oldx-hij',
    transcript: 'Kari Test: Hei.',
    summary: '',
  }, { nowMs: nowMs - 20 * DAY });
  const card = [{ clientId: 'c-old', row: { meetingId: id, hasTranscript: true, summary: '' } }];
  const plan = ingest.planFirefliesHydration({ storedRows: [ff.readStoredFirefliesMeeting(id)], clientRows: card, readStored: ff.readStoredFirefliesMeeting, nowMs });
  assert.deepEqual(plan.fetch, [id]);
  const result = await ingest.hydrateFirefliesTranscript(id, {
    apiKey: 'fake-key',
    nowMs,
    fetchTranscript: async () => ({
      ...listRow(id, nowMs - 20 * DAY),
      sentences: [{ speaker_name: 'Kari Test', text: 'Hei.' }],
      summary: { overview: 'Kunden vil ha nettside.', action_items: '- Send tilbud' },
    }),
  });
  assert.equal(result.record.summary, 'Kunden vil ha nettside.');
  const next = ingest.planFirefliesHydration({ storedRows: [ff.readStoredFirefliesMeeting(id)], clientRows: card, readStored: ff.readStoredFirefliesMeeting, nowMs: nowMs + MIN });
  assert.deepEqual(next, { fetch: [], relink: [{ clientId: 'c-old', meetingId: id }] }, 'then only the card is brought up to date');
});

test('server.js: the paste route, the backfill, Fyll ut and the letter fill follow the intake rules', () => {
  const server = readFileSync(fileURLToPath(new URL('../server.js', import.meta.url)), 'utf8');
  const between = (from, to) => server.slice(server.indexOf(from), server.indexOf(to, server.indexOf(from) + from.length));
  const paste = between("app.post('/api/admin/sales/:id/offer/use-meeting'", "app.post('/api/admin/sales/:id/offer/request-review'");
  // The route re-reads the client after each link: a const there threw after linking.
  assert.match(paste, /^\s*let client = sales\.getSalesClientById\(req\.params\.id\);/m);
  assert.doesNotMatch(paste, /const client = /);
  assert.match(paste, /if \(isTryLaterError\(error\)\) askedToWait = true;/);
  assert.match(paste, /if \(!matches\.length && askedToWait\) \{\s*return res\.status\(503\)/);
  const backfill = between('function ensureFirefliesMeetLinkBackfill(', 'function clientAfterFirefliesBackfill(');
  assert.match(backfill, /if \(firefliesStoreSource\('meetings'\) === 'unreadable'\) return firefliesMeetLinkBackfillSummary;[^]*applyFirefliesMeetLinkBackfill\(\{ archiveLost \}\)/);
  const offer = between('async function hydrateOfferMeetings(', 'function selectedOfferMeetingIds(');
  assert.match(offer, /if \(stored && !firefliesFetchDue\(stored, \{ onDemand: true \}\)\) continue;/);
  const link = between('function linkFetchedFirefliesTranscript(', 'async function hydrateRecentStoredTranscripts(');
  assert.match(link, /if \(!ref && storedMeetingIsPartial\(record\)\) return null;/);
  const fill = between('async function fillPendingContractLetters(', 'async function autoFillOfferIfReady(');
  assert.match(fill, /storedMeetingIsPartial\(readStoredFirefliesMeeting\(row\.meetingId\)\)\)\) continue;/);
  // The decline route (and its undo) decides in lib/fireflies-recording-watchdog.js recordingDecision, which
  // only ever picks a placeholder (scripts/fireflies-live-alerts.test.mjs).
  const declined = between("app.post('/api/admin/sales/:id/fireflies/recording'", "app.get('/api/admin/fireflies/meetings/:meetingId'");
  assert.match(declined, /canAccessSalesClient\(req, client\)/);
  assert.match(declined, /recordingDecision\(\{[^]*by: workshopAuthorLabel\(req\),[^]*\}\)/);
  assert.match(declined, /sales\.patchSalesClientMeeting\(client\.id, decision\.meetingId, \{ recording: decision\.recording \}\)/);
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
