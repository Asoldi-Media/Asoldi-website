import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  collectWorkshopSummaryInputs,
  summarizeWorkshopForDeveloper,
  WORKSHOP_SUMMARY_SECTIONS,
  NOTES_ONLY_DISCLAIMER,
} from '../lib/workshop-summary.js';
import {
  ITERATION_DURATION_MINUTES,
  buildIterationCalendarPlan,
  buildIterationInvitePayload,
  buildIterationPrivatePayload,
} from '../lib/workshop-iteration.js';
import {
  clientMeetingHover,
  persistWorkshopRecord,
  normalizeWorkshopRecord,
} from '../lib/workshop-record.js';
import { getWorkshopAction } from '../lib/workshop-action.js';
import {
  buildMeetingAttendees,
  resolveMeetingEventDurationMinutes,
  resolveSalesReminderDurationMinutes,
  shouldIncludeFireflies,
} from '../lib/google-calendar.js';

const here = dirname(fileURLToPath(import.meta.url));
const DUE = '2026-10-08T12:00:00.000Z';

function readNearby(rel) {
  return readFileSync(join(here, rel), 'utf8');
}

test('summary builder returns Intro, Voice, What they want, and Functionality', async () => {
  const result = await summarizeWorkshopForDeveloper({
    client: {
      businessName: 'Test Bakeri',
      notes: 'De vil ha et rolig uttrykk.',
      details: { meetingQuote: { productNotes: 'Meny og booking', productGoal: 'Flere bordbestillinger' } },
    },
    salesMeeting: { transcript: 'Selger: Hva trenger dere?\nKunde: En meny og booking på nettsiden.' },
    workshopMeeting: { transcript: 'Admin: Vi går gjennom innhold.\nKunde: Booking først.' },
    offer: { products: [{ name: 'Tier 2', pages: 5 }], email: { html: '<p>Tilbud</p>' } },
    deps: {
      chat: async () => ({
        intro: 'Test Bakeri er et bakeri.',
        voice: 'Rolig og konkret.',
        whatTheyWant: 'Meny og booking.',
        functionality: 'Nettsiden må vise meny og ta imot bordbestilling.',
      }),
    },
  });
  for (const key of WORKSHOP_SUMMARY_SECTIONS) {
    assert.equal(typeof result[key], 'string');
    assert.ok(result[key].length > 0, `${key} should not be empty`);
  }
  assert.equal(result.language, 'nb');
  assert.equal(result.fromNotesOnly, false);
  assert.equal(result.source, 'ai');
});

test('empty workshop transcript still summarizes from sales notes', async () => {
  const client = {
    businessName: 'Test Bakeri',
    notes: 'De vil ha online booking og en enkel meny.',
    details: { meetingQuote: { productNotes: 'Booking på forsiden. Ingen nettbutikk.' } },
    workshopAction: { format: 'sms-ring', dueAt: DUE },
    clientDataBank: { logos: { normal: 'do-not-touch.png' } },
  };
  const bankBefore = JSON.stringify(client.clientDataBank);
  const collected = collectWorkshopSummaryInputs({
    client,
    salesMeeting: { transcript: 'Kunde: vi trenger bordbestilling fra telefonen.' },
    workshopMeeting: {},
    offer: {},
  });
  assert.equal(collected.fromNotesOnly, true);
  assert.equal(collected.workshopTranscript, '');
  assert.match(collected.salesNotes, /online booking/);
  assert.match(collected.productNotes, /Booking på forsiden/);
  const result = await summarizeWorkshopForDeveloper({
    client,
    salesMeeting: { transcript: 'Kunde: vi trenger bordbestilling fra telefonen.' },
    workshopMeeting: {},
  });
  for (const key of WORKSHOP_SUMMARY_SECTIONS) {
    assert.ok(result[key], `${key} missing`);
  }
  assert.equal(result.fromNotesOnly, true);
  assert.match(result.intro, /notater|salgsmøtet/i);
  assert.match(NOTES_ONLY_DISCLAIMER, /notater og salgsmøtet/);
  assert.equal(JSON.stringify(client.clientDataBank), bankBefore);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'clientDataBank'), false);
});

test('summary builder never writes clientDataBank', async () => {
  const summarySrc = readNearby('../lib/workshop-summary.js');
  assert.equal(summarySrc.includes('clientDataBank'), false);
  assert.equal(summarySrc.includes('setClientDataBank'), false);
  assert.equal(summarySrc.includes('summarizeClientIntent'), false);
  const recordSrc = readNearby('../lib/workshop-record.js');
  assert.equal(recordSrc.includes('clientDataBank'), false);
  const notesSrc = readNearby('../lib/workshop-notes.js');
  assert.equal(notesSrc.includes('setClientDataBank'), false);
  const invoiceSrc = readNearby('../lib/workshop-invoice.js');
  assert.equal(invoiceSrc.includes('setClientDataBank'), false);
  const bank = { logos: { normal: 'keep.png' } };
  const client = { businessName: 'X', notes: 'Notat', clientDataBank: bank };
  await summarizeWorkshopForDeveloper({ client, salesMeeting: { transcript: 'Hei' } });
  assert.equal(client.clientDataBank, bank);
  assert.equal(client.clientDataBank.logos.normal, 'keep.png');
});

test('iteration Møte is a 30-minute invite with Meet and Fireflies', () => {
  const client = {
    businessName: 'Test Bakeri',
    contactEmail: 'daracha777@gmail.com',
    calendar: { eventId: 'sales-event', meetLink: 'https://meet.google.com/sales-only' },
    workshopAction: { format: 'mote', dueAt: '2026-11-01T10:00:00.000Z', calendarEventId: 'workshop-event' },
  };
  const meeting = { format: 'mote', dueAt: DUE, name: 'Iterasjonsmøte' };
  const plan = buildIterationCalendarPlan(meeting, client);
  const invite = buildIterationInvitePayload(client, meeting);
  assert.equal(plan.createEvent, true);
  assert.equal(plan.kind, 'invite');
  assert.equal(invite.durationMinutes, 30);
  assert.equal(invite.durationMinutes, ITERATION_DURATION_MINUTES);
  assert.equal(invite.sendUpdates, 'all');
  assert.equal(invite.meetingMode, 'online');
  assert.equal(invite.includeMeet, true);
  assert.equal(invite.options.durationMinutes, 30);
  assert.equal(invite.options.addFireflies, true);
  assert.equal(invite.client.meetingAt, DUE);
  assert.notEqual(invite.client.calendar?.eventId, 'sales-event');
  assert.equal(invite.client.meetingAt, DUE);
  assert.notEqual(invite.client.meetingAt, client.workshopAction.dueAt);
  const includeFireflies = shouldIncludeFireflies({
    isOnline: true,
    addFireflies: true,
    sendUpdates: 'all',
    alreadyOnEvent: false,
  });
  const attendees = buildMeetingAttendees(invite.client, { includeAttendees: true, includeFireflies });
  assert.equal(attendees.some((entry) => entry.email === 'daracha777@gmail.com'), true);
  assert.equal(attendees.some((entry) => String(entry.email).endsWith('@fireflies.ai')), true);
  assert.equal(resolveMeetingEventDurationMinutes({ meetingMode: 'online' }, invite.options), 30);
});

test('iteration SMS/ring is 30 minutes and not an invite', () => {
  const client = {
    businessName: 'Test Bakeri',
    contactEmail: 'daracha777@gmail.com',
    calendar: { eventId: 'sales-event' },
  };
  const meeting = { format: 'sms-ring', dueAt: DUE, addToCalendar: true };
  const plan = buildIterationCalendarPlan(meeting, client);
  const privateEvent = buildIterationPrivatePayload(client, meeting);
  assert.equal(plan.createEvent, true);
  assert.equal(plan.kind, 'private');
  assert.equal(privateEvent.durationMinutes, 30);
  assert.equal(privateEvent.sendUpdates, 'none');
  assert.deepEqual(privateEvent.attendees, []);
  assert.equal(privateEvent.includeMeet, false);
  assert.equal(privateEvent.includeFireflies, false);
  assert.equal(resolveSalesReminderDurationMinutes(privateEvent.options), 30);
  const silent = buildIterationCalendarPlan({ format: 'sms-ring', dueAt: DUE, addToCalendar: false }, client);
  assert.equal(silent.createEvent, false);
  assert.equal(silent.kind, 'none');
});

test('T07 does not create a second workshop booking clock', () => {
  const client = {
    workshopAction: { name: 'Workshop', format: 'mote', dueAt: DUE },
    workshop: {
      action: { format: 'sms-ring', dueAt: '2026-12-01T10:00:00.000Z' },
      heldAt: '',
      goalActions: [{ id: 'wga-1', name: 'Ring dagen før', format: 'ring', dueAt: DUE }],
    },
    details: { workshopAction: { format: 'mote', dueAt: '2026-11-01T09:00:00.000Z' } },
  };
  const booked = getWorkshopAction(client);
  assert.equal(booked.dueAt, DUE);
  assert.equal(booked.format, 'mote');
  const stored = persistWorkshopRecord(client.workshop);
  assert.equal(stored?.heldAt || '', '');
  assert.equal(Object.prototype.hasOwnProperty.call(normalizeWorkshopRecord(client.workshop), 'action'), false);
  assert.equal(stored.goalActions.length, 1);
  assert.equal(stored.goalActions[0].format, 'ring');
  assert.equal(stored.goalActions[0].name, 'Ring dagen før');
});

test('hover uses that meeting id, never meetings[0]', () => {
  const client = {
    meetings: [
      { meetingId: 'latest-other', purpose: 'sales', hasVideo: true },
      { meetingId: 'ws-video', purpose: 'workshop', hasVideo: true },
    ],
    workshopAction: { format: 'mote', dueAt: DUE, firefliesMeetingId: 'ws-video' },
    workshop: { iterationMeeting: { firefliesMeetingId: 'iter-1' } },
  };
  const workshop = clientMeetingHover(client, 'workshop');
  assert.equal(workshop.meetingId, 'ws-video');
  assert.notEqual(workshop.meetingId, client.meetings[0].meetingId);
  const iteration = clientMeetingHover(client, 'iteration');
  assert.equal(iteration.meetingId, 'iter-1');
  assert.notEqual(iteration.meetingId, 'latest-other');
});

test('T06 still mounts T01/T02 and T07 fills the existing actions slot', () => {
  const adminSrc = readNearby('../app/pages/Admin/sections/AdminBoardSection.tsx');
  assert.match(adminSrc, /WorkshopNeedsPanel/);
  assert.match(adminSrc, /AdminRequestInbox/);
  assert.match(adminSrc, /data-admin-card-actions/);
  assert.match(adminSrc, /WorkshopAdminActionRow/);
  assert.equal(adminSrc.includes('ManageClientsView'), false);

  const serverSrc = readNearby('../server.js');
  assert.match(serverSrc, /\/api\/admin\/sales\/:id\/workshop-needs/);
  assert.match(serverSrc, /\/api\/admin\/dev-requests/);
  assert.match(serverSrc, /\/api\/admin\/sales\/:id\/workshop-action/);
  assert.match(serverSrc, /\/api\/admin\/sales\/preview-send-emails/);
  assert.match(serverSrc, /\/api\/admin\/sales\/:id\/workshop\/summary/);
  assert.equal(serverSrc.includes('summarizeClientIntent({'), true);

  const developerSrc = readNearby('../app/pages/Admin/sections/DevelopmentClientsSection.tsx');
  assert.match(developerSrc, /DeveloperRunQueueBar/);
  const cardSrc = readNearby('../app/pages/developer/DeveloperClientCard.tsx');
  assert.match(cardSrc, /DeveloperRequestThread/);
  assert.equal(developerSrc.includes('DeveloperRequestThread'), false);
});
