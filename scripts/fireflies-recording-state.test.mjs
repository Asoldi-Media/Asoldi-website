import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-recording-state-'));
process.env.APP_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const {
  mergeRecordingState,
  normalizeRecordingState,
  sessionKeyFor,
  slotKeyFor,
  slotKindFromKey,
} = await import('../lib/fireflies-recording-state.js');

test('session keys pair the normalized Meet room with the start time', () => {
  assert.equal(
    sessionKeyFor('https://meet.google.com/abc-defg-hij?authuser=1', '2026-10-23T10:00:00.000Z'),
    'https://meet.google.com/abc-defg-hij|1792749600000',
  );
  assert.equal(sessionKeyFor('', '2026-10-23T10:00:00.000Z'), '');
  assert.equal(sessionKeyFor('https://meet.google.com/abc-defg-hij', 'not a date'), '');
});

test('slot keys name the booked slot of one client', () => {
  assert.equal(slotKeyFor('sales', { startAt: '2026-10-23T10:00:00.000Z' }), 'sales:1792749600000');
  assert.equal(slotKeyFor('workshop', { startAt: '2026-10-23T10:00:00.000Z' }), 'workshop:1792749600000');
  assert.equal(slotKeyFor('action', { actionId: 'act-1' }), 'action:act-1');
  assert.equal(slotKeyFor('action', {}), '');
  assert.equal(slotKeyFor('other', { startAt: '2026-10-23T10:00:00.000Z' }), '');
  assert.equal(slotKindFromKey('iteration:1792749600000'), 'iteration');
  assert.equal(slotKindFromKey('nope:1'), '');
});

test('recording state keeps known states only and merges patches', () => {
  assert.equal(normalizeRecordingState(null), null);
  assert.equal(normalizeRecordingState({ state: 'joined' }), null);
  const dispatched = normalizeRecordingState({ state: 'dispatched', attempts: 1, dispatchedAt: '2026-10-23T09:57:40.000Z' });
  assert.equal(dispatched.state, 'dispatched');
  assert.equal(dispatched.attempts, 1);
  assert.equal(dispatched.verifiedAt, '');
  const merged = mergeRecordingState(dispatched, { state: 'recording', verifiedAt: '2026-10-23T10:01:00.000Z', ffMeetingId: 'FF1' });
  assert.equal(merged.state, 'recording');
  assert.equal(merged.attempts, 1);
  assert.equal(merged.dispatchedAt, '2026-10-23T09:57:40.000Z');
  assert.equal(merged.ffMeetingId, 'FF1');
});

test('client meeting rows keep slotKey and recording, and patchSalesClientMeeting merges into one row', async () => {
  const sales = await import('../data/sales.js');
  const client = sales.createSalesClient({ businessName: 'Testfirma AS', contactPerson: 'Kari Test' });
  const stubId = sales.liveJoinMeetingId(client.id, '2026-10-23T10:00:00.000Z');
  sales.linkMeetingToSalesClient(client.id, {
    meetingId: stubId,
    title: 'Testfirma AS · Kari Test',
    startedAt: '2026-10-23T10:00:00.000Z',
    meetLink: 'https://meet.google.com/abc-defg-hij',
    hasTranscript: false,
    source: 'live-join',
    linkedBy: 'live-join',
    slotKey: 'sales:1792749600000',
    recording: { state: 'dispatched', attempts: 1, dispatchedAt: '2026-10-23T09:57:40.000Z' },
  });
  let row = sales.getSalesClientById(client.id).meetings.find((entry) => entry.meetingId === stubId);
  assert.equal(row.slotKey, 'sales:1792749600000');
  assert.equal(row.recording.state, 'dispatched');

  const patched = sales.patchSalesClientMeeting(client.id, stubId, {
    recording: { state: 'recording', verifiedAt: '2026-10-23T10:01:00.000Z' },
  });
  row = patched.meetings.find((entry) => entry.meetingId === stubId);
  assert.equal(row.recording.state, 'recording');
  assert.equal(row.recording.attempts, 1);
  assert.equal(row.title, 'Testfirma AS · Kari Test');

  assert.equal(sales.patchSalesClientMeeting(client.id, 'live:missing:1', { recording: { state: 'missing' } }), null);
  const cleared = sales.patchSalesClientMeeting(client.id, stubId, { recording: null });
  assert.equal(cleared.meetings.find((entry) => entry.meetingId === stubId).recording, null);
});
