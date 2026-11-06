import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendStampedSalesNote,
  buildSalesCardLog,
  parseSalesNoteLog,
  stampSalesNoteLine,
} from '../lib/sales-card-log.js';

const NOTE_AT = '2026-11-05T09:02:00.000Z';
const CALL_AT = '2026-11-06T14:19:00.000Z';
const MEETING_AT = '2026-10-02T12:00:00.000Z';

function client(overrides = {}) {
  return {
    id: 'c-log',
    product: 'asoldi',
    businessName: 'Test AS',
    agreedTime: true,
    meetingAt: MEETING_AT,
    notes: '',
    progression: {
      meetingHeld: false,
      offerSent: false,
      contractSigned: false,
    },
    nextActions: [],
    meetings: [],
    ...overrides,
  };
}

test('stamped notes round-trip and keep a legacy blob without inventing a time', () => {
  const stamped = stampSalesNoteLine('Ikke svar', CALL_AT);
  assert.equal(stamped, `[${CALL_AT}] Ikke svar`);
  const notes = appendStampedSalesNote('Eldre notat uten tid\nAndre linje', 'Ikke svar', CALL_AT);
  assert.deepEqual(parseSalesNoteLog(notes), [
    { at: '', text: 'Eldre notat uten tid\nAndre linje' },
    { at: CALL_AT, text: 'Ikke svar' },
  ]);
  const multi = appendStampedSalesNote('', 'Ikke svar\nPrøver igjen i morgen', NOTE_AT);
  assert.deepEqual(parseSalesNoteLog(multi), [
    { at: NOTE_AT, text: 'Ikke svar\nPrøver igjen i morgen' },
  ]);
});

test('card log puts the last note and last done action on top, and skips open actions', () => {
  const rows = buildSalesCardLog(client({
    notes: `[${NOTE_AT}] Ikke svar\n[${CALL_AT}] Ikke svar`,
    nextActions: [
      {
        id: 'na-ring',
        goalKey: 'meetingHeld',
        presetKey: 'custom',
        name: 'Ring',
        format: 'ring',
        dueAt: '2026-11-06T13:00:00.000Z',
        doneAt: CALL_AT,
        note: 'Ingen som tok',
      },
      {
        id: 'na-open',
        goalKey: 'meetingHeld',
        presetKey: 'custom',
        name: 'Ring igjen',
        format: 'ring',
        dueAt: '2026-11-07T09:00:00.000Z',
        doneAt: '',
      },
    ],
  }), Date.parse('2026-11-06T15:00:00.000Z'));
  assert.equal(rows[0].kind, 'note');
  assert.equal(rows[0].text, 'Ikke svar');
  assert.equal(rows[0].at, CALL_AT);
  const ring = rows.find((row) => row.id === 'action:na-ring');
  assert.equal(ring.name, 'Ring');
  assert.equal(ring.formatLabel, 'Ring');
  assert.equal(ring.text, 'Ingen som tok');
  assert.equal(ring.at, CALL_AT);
  assert.ok(!rows.some((row) => row.id === 'action:na-open'));
});

test('a held meeting lands in the log at the meeting time, not as an open row', () => {
  const rows = buildSalesCardLog(client({
    progression: { meetingHeld: true, offerSent: false, contractSigned: false },
    nextActions: [
      {
        id: 'na-meeting',
        goalKey: 'meetingHeld',
        presetKey: 'meeting',
        name: 'Møte',
        format: 'mote',
        dueAt: MEETING_AT,
        doneAt: '2026-10-02T13:00:00.000Z',
        firefliesMeetingId: 'ff-sales',
      },
    ],
    meetings: [
      {
        meetingId: 'ff-sales',
        title: 'Salgsmøte Test AS',
        when: '02.10.2026, 14:00',
        startedAt: MEETING_AT,
        hasTranscript: true,
      },
    ],
    salesPlaybook: { readUpAt: '2026-10-02T08:00:00.000Z', missedCalledAt: '' },
    contractSignedAt: '',
  }));
  const meeting = rows.find((row) => row.id === 'action:na-meeting');
  assert.equal(meeting.at, MEETING_AT);
  assert.ok(!rows.some((row) => row.id === 'meeting:ff-sales'), 'same recording is not a second row');
  assert.ok(rows.some((row) => row.id === 'playbook:readUp'));
});
