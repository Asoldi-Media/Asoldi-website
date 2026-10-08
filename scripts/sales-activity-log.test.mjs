import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attachFirefliesToMatchingAction,
  buildClientActivityLog,
  firefliesUrlForMeeting,
  meetingMatchesAction,
} from '../lib/sales-activity-log.js';
import { seedOfferMeetingIds, toggleOfferMeetingId } from '../lib/offer-meetings.js';

const MEETING_AT = '2026-10-02T12:00:00.000Z';
const PLANNING_AT = '2026-10-06T09:00:00.000Z';

function client(overrides = {}) {
  return {
    id: 'c-log',
    product: 'asoldi',
    businessName: 'Test AS',
    agreedTime: true,
    meetingAt: MEETING_AT,
    progression: {
      meetingHeld: true,
      offerSent: false,
      contractSigned: false,
    },
    nextActions: [
      {
        id: 'na-sms1h-c-log',
        goalKey: 'meetingHeld',
        presetKey: 'sms1h',
        name: 'Påminnelse',
        format: 'sms',
        dueAt: '2026-10-01T12:00:00.000Z',
        doneAt: '2026-10-01T12:30:00.000Z',
        addToCalendar: false,
      },
      {
        id: 'na-meeting-c-log',
        goalKey: 'meetingHeld',
        presetKey: 'meeting',
        name: 'Møte',
        format: 'mote',
        dueAt: MEETING_AT,
        doneAt: '2026-10-02T13:00:00.000Z',
        addToCalendar: true,
        firefliesMeetingId: 'ff-sales',
      },
      {
        id: 'na-plan',
        goalKey: 'offerSent',
        presetKey: 'custom',
        name: 'Planlegg neste møte',
        format: 'mote',
        dueAt: PLANNING_AT,
        doneAt: '',
        addToCalendar: true,
        meetLink: 'https://meet.google.com/aaa-bbbb-ccc',
      },
    ],
    meetings: [
      {
        meetingId: 'ff-sales',
        title: 'Salgsmøte Test AS',
        when: '02.10.2026, 14:00',
        startedAt: MEETING_AT,
        transcriptUrl: 'https://app.fireflies.ai/view/ff-sales',
        hasTranscript: true,
        purpose: 'sales',
      },
      {
        meetingId: 'ff-plan',
        title: 'Planlegging neste gang',
        when: '06.10.2026, 11:00',
        startedAt: PLANNING_AT,
        meetLink: 'https://meet.google.com/aaa-bbbb-ccc',
        transcriptUrl: 'https://app.fireflies.ai/view/ff-plan',
        hasTranscript: true,
      },
    ],
    ...overrides,
  };
}

test('activity log groups reminders and recordings under sales goal headers', () => {
  const log = buildClientActivityLog(client());
  assert.deepEqual(log.sections.map((section) => section.key), ['meetingHeld', 'offerSent']);
  assert.equal(log.sections[0].label, 'Møte');
  assert.equal(log.sections[1].label, 'Tilbud');
  const heldNames = log.sections[0].rows.map((row) => row.name);
  assert.ok(heldNames.includes('Påminnelse'));
  assert.ok(heldNames.includes('Møte'));
  const meetingRow = log.sections[0].rows.find((row) => row.name === 'Møte');
  assert.equal(meetingRow.meeting.meetingId, 'ff-sales');
  assert.match(meetingRow.meeting.firefliesUrl, /ff-sales/);
  const planRow = log.sections[1].rows.find((row) => row.name === 'Planlegg neste møte');
  assert.equal(planRow.meeting.meetingId, 'ff-plan');
  const heldTimes = log.sections[0].rows.map((row) => Date.parse(row.at));
  assert.ok(heldTimes[0] <= heldTimes[heldTimes.length - 1]);
});

test('Fireflies URL and meet-link attach a recording to the matching action', () => {
  assert.equal(firefliesUrlForMeeting({ meetingId: 'abc', transcriptUrl: 'https://app.fireflies.ai/view/abc' }), 'https://app.fireflies.ai/view/abc');
  assert.equal(meetingMatchesAction(
    { meetingId: 'ff-plan', meetLink: 'https://meet.google.com/aaa-bbbb-ccc', startedAt: PLANNING_AT },
    { format: 'mote', meetLink: 'https://meet.google.com/aaa-bbbb-ccc', dueAt: PLANNING_AT },
  ), true);
  const attached = attachFirefliesToMatchingAction(client().nextActions, {
    meetingId: 'ff-plan',
    meetLink: 'https://meet.google.com/aaa-bbbb-ccc',
    startedAt: PLANNING_AT,
  });
  assert.equal(attached.actionId, 'na-plan');
  assert.equal(attached.actions.find((action) => action.id === 'na-plan').firefliesMeetingId, 'ff-plan');
});

test('open offers seed every transcript and toggle membership', () => {
  const row = client();
  const seeded = seedOfferMeetingIds({ status: 'draft' }, row);
  assert.deepEqual(seeded, ['ff-sales', 'ff-plan']);
  const locked = seedOfferMeetingIds({ status: 'sent', meetingId: 'ff-sales' }, row);
  assert.deepEqual(locked, ['ff-sales']);
  assert.deepEqual(toggleOfferMeetingId({ meetingIds: ['ff-sales', 'ff-plan'] }, 'ff-plan'), ['ff-sales']);
  assert.deepEqual(toggleOfferMeetingId({ meetingIds: ['ff-sales'] }, 'ff-plan'), ['ff-sales', 'ff-plan']);
});

test('saved offer selection is not refilled with every transcript', () => {
  const row = client();
  assert.deepEqual(seedOfferMeetingIds({
    status: 'draft',
    meetingSource: 'manual',
    meetingIds: ['ff-sales'],
    meetingId: 'ff-sales',
  }, row), ['ff-sales']);
  assert.deepEqual(seedOfferMeetingIds({
    status: 'draft',
    meetingSource: 'manual',
    meetingIds: [],
  }, row), []);
});

test('activity log prefers the real transcript over a live-join stub', () => {
  const log = buildClientActivityLog(client({
    meetings: [
      {
        meetingId: 'live:c-log:open',
        title: 'Fireflies ble sendt inn',
        meetLink: 'https://meet.google.com/sales-meet-abc',
        startedAt: MEETING_AT,
        hasTranscript: false,
        linkedBy: 'live-join',
        forSalesMeeting: true,
      },
      {
        meetingId: 'ff-sales',
        title: 'Salgsmøte Test AS',
        when: '02.10.2026, 14:00',
        startedAt: MEETING_AT,
        meetLink: 'https://meet.google.com/sales-meet-abc',
        transcriptUrl: 'https://app.fireflies.ai/view/ff-sales',
        hasTranscript: true,
        purpose: 'sales',
        forSalesMeeting: true,
      },
    ],
  }));
  const meetingRow = log.sections[0].rows.find((row) => row.name === 'Møte');
  assert.equal(meetingRow.meeting.meetingId, 'ff-sales');
  assert.equal(meetingRow.meeting.hasTranscript, true);
  const waiting = log.sections.flatMap((section) => section.rows).filter((row) => row.meeting && !row.meeting.hasTranscript);
  assert.equal(waiting.length, 0);
});

test('open offers drop live-join stubs once a real transcript exists', () => {
  const row = client();
  const seeded = seedOfferMeetingIds({
    status: 'draft',
    meetingId: 'live:c-log:open',
    meetingIds: ['live:c-log:open'],
  }, row);
  assert.ok(!seeded.includes('live:c-log:open'));
  assert.deepEqual(seeded, ['ff-sales', 'ff-plan']);
});
