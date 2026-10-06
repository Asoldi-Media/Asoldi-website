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
  iterationEmailShouldSend,
} from '../lib/workshop-iteration.js';
import {
  clientMeetingHover,
  persistWorkshopRecord,
  normalizeWorkshopRecord,
} from '../lib/workshop-record.js';
import {
  applyWorkshopGoalActionOp,
  getAdminCurrentGoalKey,
  getAdminVisibleGoalKeys,
  resolveAdminMeetJoin,
} from '../lib/workshop-goal-timeline.js';
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
  assert.equal(invite.options.calendarId, 'primary');
  assert.equal(invite.options.forceGuestInvite, true);
  assert.equal(invite.calendarId, 'primary');
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

test('T06 mounts T01 needs, T02 inbox, and T07 actions; Forespørsler is a header dropdown', () => {
  const adminSrc = readNearby('../app/pages/Admin/sections/AdminBoardSection.tsx');
  assert.match(adminSrc, /WorkshopNeedsPanel/);
  assert.match(adminSrc, /AdminRequestInbox/);
  assert.match(adminSrc, /data-admin-card-actions/);
  assert.match(adminSrc, /WorkshopAdminActionRow/);
  assert.match(adminSrc, /Details & tools/);
  assert.match(adminSrc, /Adminterminal/);
  assert.match(adminSrc, /Forespørsler/);
  assert.match(adminSrc, /Vis e-posthandlinger/);
  assert.match(adminSrc, /SalesCalendarWeek/);
  assert.match(adminSrc, /workshopCalendar/);
  assert.match(adminSrc, /h-\[1em\] w-\[1\.1em\]/);
  assert.match(adminSrc, /bg-neutral-500/);
  const salesSrc = readNearby('../app/pages/Admin/sections/SalesClientsSection.tsx');
  assert.match(salesSrc, /h-\[1em\] w-\[1\.1em\]/);
  assert.match(salesSrc, /bg-neutral-500/);
  assert.equal(adminSrc.includes('Search and filter'), false);
  assert.equal(adminSrc.includes('ManageClientsView'), false);
  assert.equal(adminSrc.includes('SalesGoalTimeline'), false);

  const rowSrc = readNearby('../app/pages/Admin/sections/WorkshopAdminActionRow.tsx');
  assert.match(rowSrc, /ChevronsDown/);
  assert.match(rowSrc, /getAdminCurrentGoalKey/);
  assert.match(rowSrc, /Iterasjonsmøte/);
  assert.match(rowSrc, /currentGoal === 'iterated'/);
  assert.match(rowSrc, /Møtetid/);
  assert.match(rowSrc, /workshopDraft/);
  assert.match(rowSrc, /Meet link/);
  assert.match(rowSrc, /resolveAdminMeetJoin/);
  assert.match(rowSrc, /damian@asoldi\.com/);

  const serverSrc = readNearby('../server.js');
  assert.match(serverSrc, /\/api\/admin\/sales\/:id\/workshop-needs/);
  assert.match(serverSrc, /\/api\/admin\/dev-requests/);
  assert.match(serverSrc, /\/api\/admin\/sales\/:id\/workshop-action/);
  assert.match(serverSrc, /\/api\/admin\/sales\/:id\/workshop\/goal-actions/);
  assert.match(serverSrc, /\/api\/admin\/sales\/preview-send-emails/);
  assert.match(serverSrc, /\/api\/admin\/sales\/:id\/workshop\/summary/);
  assert.match(serverSrc, /\/api\/admin\/sales\/:id\/workshop\/informasjon/);
  assert.match(serverSrc, /\/api\/admin\/sales\/:id\/workshop\/desk-email/);
  const dueFn = serverSrc.slice(
    serverSrc.indexOf('async function sendDueWorkshopDeskEmails'),
    serverSrc.indexOf('async function sendIterationMeetingEmail'),
  );
  assert.ok(dueFn.includes('workshop-reminder-3d'));
  assert.equal(dueFn.includes('data-innsamling'), false);
  assert.equal(dueFn.includes('dataInnsamlingScheduleAt'), false);
  assert.equal(adminSrc.includes('Datainnsamling sendes manuelt'), true);
  assert.equal(serverSrc.includes('summarizeClientIntent({'), true);

  const developerSrc = readNearby('../app/pages/Admin/sections/DevelopmentClientsSection.tsx');
  assert.match(developerSrc, /DeveloperRunQueueBar/);
  assert.match(developerSrc, /flex-1 overflow-x-auto/);
  const cardSrc = readNearby('../app/pages/developer/DeveloperClientCard.tsx');
  assert.match(cardSrc, /DeveloperRequestThread/);
  assert.match(cardSrc, /Få tilbakemelding/);
  assert.equal(developerSrc.includes('DeveloperRequestThread'), false);
});

test('Admin goal chips hide Informasjon and Iterasjon until the previous goal is done', () => {
  const open = { workshop: { heldAt: '', summary: null } };
  assert.equal(getAdminCurrentGoalKey(open), 'haWorkshop');
  assert.deepEqual(getAdminVisibleGoalKeys(open), ['haWorkshop']);
  const held = { workshop: { heldAt: DUE, summary: { intro: 'x', voice: 'x', whatTheyWant: 'x', functionality: 'x' } } };
  assert.equal(getAdminCurrentGoalKey(held), 'informasjon');
  assert.deepEqual(getAdminVisibleGoalKeys(held), ['haWorkshop', 'informasjon']);
  const info = { workshop: { ...held.workshop, informasjonAt: DUE } };
  assert.equal(getAdminCurrentGoalKey(info), 'iterated');
  assert.deepEqual(getAdminVisibleGoalKeys(info), ['haWorkshop', 'informasjon', 'iterated']);
});

test('extra goal-action create does not look like confirmSend', () => {
  const applied = applyWorkshopGoalActionOp({ goalActions: [] }, {
    op: 'create',
    goalKey: 'haWorkshop',
    presetKey: 'sms24h',
    name: 'SMS 24h',
    format: 'sms',
    dueAt: DUE,
    addToCalendar: false,
  });
  assert.equal(applied.error, undefined);
  assert.equal(applied.goalActions.length, 1);
  assert.equal(applied.goalActions[0].goalKey, 'haWorkshop');
  assert.equal(Object.prototype.hasOwnProperty.call(applied, 'confirmSend'), false);
  const rowSrc = readNearby('../app/pages/Admin/sections/WorkshopAdminActionRow.tsx');
  assert.match(rowSrc, /workshop\/goal-actions/);
  assert.match(rowSrc, /confirmSend: true/);
  assert.equal(/confirmSend: true,\s*goalActions/.test(rowSrc), false);
});

test('workshop extra-action time stays on dueAt even if a clock was typed into notes', () => {
  const created = applyWorkshopGoalActionOp({ goalActions: [] }, {
    op: 'create',
    id: 'wga-ring-1',
    goalKey: 'haWorkshop',
    presetKey: 'custom',
    name: 'Ring kunden',
    format: 'ring',
    dueAt: '',
    note: '2026-10-06T10:00',
    addToCalendar: false,
  });
  assert.equal(created.error, undefined);
  assert.equal(created.goalActions[0].dueAt, '2026-10-06T08:00:00.000Z');
  assert.equal(created.goalActions[0].note, '');
  const updated = applyWorkshopGoalActionOp(created, {
    op: 'update',
    id: created.goalActions[0].id,
    dueAt: '2026-10-07T11:00',
    note: created.goalActions[0].note,
  });
  assert.equal(updated.goalActions[0].dueAt, '2026-10-07T09:00:00.000Z');
  assert.equal(updated.goalActions[0].note, '');
});

test('iteration email send is Møte plus send gate', () => {
  const next = { format: 'mote', dueAt: DUE };
  assert.equal(iterationEmailShouldSend({}, next, { send: true }), true);
  assert.equal(iterationEmailShouldSend({}, next, {}), false);
  assert.equal(iterationEmailShouldSend({}, { format: 'sms-ring', dueAt: DUE, addToCalendar: true }, { send: true }), false);
  assert.equal(iterationEmailShouldSend({ confirmationSentAt: DUE, format: 'mote', dueAt: DUE }, next, { send: true }), false);
});

test('Admin Meet button joins as damian and never uses the sales Meet after workshop', () => {
  const workshopLink = 'https://meet.google.com/ibp-qvyu-ccd';
  const iterationLink = 'https://meet.google.com/aaa-bbbb-ccc';
  const salesLink = 'https://meet.google.com/idf-xnpu-jna';
  const booked = {
    workshopAction: { format: 'mote', meetLink: workshopLink },
    calendar: { meetLink: salesLink },
  };
  const workshopJoin = resolveAdminMeetJoin(booked);
  assert.equal(workshopJoin.source, 'workshop');
  assert.equal(workshopJoin.canOpen, true);
  assert.equal(workshopJoin.meetLink, workshopLink);
  assert.match(workshopJoin.joinUrl, /AccountChooser/);
  assert.match(workshopJoin.joinUrl, /damian%40asoldi\.com/);
  assert.match(workshopJoin.joinUrl, /hd=asoldi\.com/);
  assert.equal(workshopJoin.joinUrl.includes('idf-xnpu-jna'), false);

  const phone = resolveAdminMeetJoin({ workshopAction: { format: 'sms-ring', meetLink: workshopLink } });
  assert.equal(phone.canOpen, false);
  assert.equal(phone.joinUrl, '');

  const held = {
    workshopAction: { format: 'mote', meetLink: workshopLink },
    calendar: { meetLink: salesLink },
    workshop: {
      heldAt: DUE,
      summary: { intro: 'x' },
      iterationMeeting: { format: 'mote', meetLink: iterationLink },
    },
  };
  const afterWorkshop = resolveAdminMeetJoin(held);
  assert.equal(afterWorkshop.source, 'workshop');
  assert.equal(afterWorkshop.canOpen, false);
  assert.equal(afterWorkshop.joinUrl.includes('ibp-qvyu-ccd'), false);
  assert.equal(afterWorkshop.joinUrl.includes('idf-xnpu-jna'), false);

  const infoDone = {
    ...held,
    workshop: { ...held.workshop, informasjonAt: DUE },
  };
  const iterationJoin = resolveAdminMeetJoin(infoDone);
  assert.equal(iterationJoin.source, 'iteration');
  assert.equal(iterationJoin.meetLink, iterationLink);
  assert.equal(iterationJoin.canOpen, true);
  assert.equal(iterationJoin.joinUrl.includes('ibp-qvyu-ccd'), false);
  assert.equal(iterationJoin.joinUrl.includes('idf-xnpu-jna'), false);
});
