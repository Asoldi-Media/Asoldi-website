import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('the log shows the client mail and what the bot sent, with their own times', () => {
  const MAIL_AT = '2026-11-06T10:03:53.000Z';
  const REPLY_AT = '2026-11-06T10:04:40.000Z';
  const rows = buildSalesCardLog(client({
    inboxBot: {
      activity: [
        {
          id: 'ib-1',
          kind: 'sales_cancel',
          status: 'applied',
          cardLog: true,
          receivedAt: MAIL_AT,
          text: 'Jeg rekker dessverre ikke møtet i dag. Kan du på et annet tidspunkt?',
          replyText: 'Helt i orden, takk for at du sier ifra. Hvilken dag og tid passer bedre for deg?',
          repliedAt: REPLY_AT,
          summary: 'Bot tok bort møtet (kunden kan ikke) og ba om en ny tid.',
        },
        {
          id: 'ib-2',
          kind: 'silent',
          status: 'needs_human',
          cardLog: true,
          receivedAt: '2026-11-05T08:00:00.000Z',
          text: 'Når kommer kontrakten?',
          summary: 'Kunden spør om kontrakten.',
        },
        {
          id: 'ib-alert',
          kind: 'other',
          status: 'unmatched',
          cardLog: false,
          receivedAt: '2026-11-06T12:00:00.000Z',
          text: 'Internt varsel om at det mangler Fireflies-opptak.',
        },
      ],
    },
  }), Date.parse('2026-11-06T15:00:00.000Z'));
  const mail = rows.find((row) => row.id === 'inbox:ib-1');
  assert.deepEqual([mail.kind, mail.name, mail.at], ['email', 'E-post fra kunden', MAIL_AT]);
  const reply = rows.find((row) => row.id === 'inbox:ib-1:reply');
  assert.deepEqual([reply.name, reply.at], ['Møtet avlyst på e-post', REPLY_AT]);
  assert.match(reply.text, /Hvilken dag og tid passer/);
  assert.ok(rows.indexOf(reply) < rows.indexOf(mail), 'newest first: the answer above the mail');
  const waiting = rows.find((row) => row.id === 'inbox:ib-2');
  assert.match(waiting.text, /Venter svar fra selger: Kunden spør om kontrakten\./);
  assert.equal(rows.some((row) => row.id === 'inbox:ib-2:reply'), false, 'no answer, no answer row');
  assert.equal(rows.some((row) => row.id === 'inbox:ib-alert'), false, 'internal mail filed on the card is not a client mail');
});

test('a declined invite and a bounce are their own log rows', () => {
  const rows = buildSalesCardLog(client({
    inboxBot: {
      activity: [
        { id: 'ib-d', kind: 'sales_declined', status: 'applied', cardLog: true, receivedAt: '2026-11-09T11:02:33.000Z', summary: 'Kunden avslo møteinvitasjonen for 9. nov kl 16:00.', replyText: 'Så synd at tiden ikke passet. Passer noe av dette: …?', repliedAt: '2026-11-09T11:03:10.000Z' },
        { id: 'ib-b', kind: 'bounce', status: 'needs_human', cardLog: true, receivedAt: '2026-11-02T12:08:43.000Z', summary: 'E-post til post@teobygg.example kom ikke fram.' },
      ],
    },
  }));
  assert.equal(rows.find((row) => row.id === 'inbox:ib-d').name, 'Avslo møteinvitasjonen');
  assert.equal(rows.find((row) => row.id === 'inbox:ib-d:reply').name, 'Svar sendt (ledige tider)');
  const bounce = rows.find((row) => row.id === 'inbox:ib-b');
  assert.deepEqual([bounce.name, bounce.kind], ['E-post kom ikke fram', 'email']);
});

test('the sales card right column is the log, not a free-edit notes blob', () => {
  const board = readFileSync(new URL('../app/pages/Admin/sections/SalesClientsSection.tsx', import.meta.url), 'utf8');
  assert.match(board, /renderNotes=\{renderClientSalesLog\}/);
  assert.match(board, /append:\s*line/);
  assert.doesNotMatch(board, /function ClientNotesField/);
});
