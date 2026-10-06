import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INFORMASJON_ACTION_ID,
  FEEDBACK_ACTION_ID,
  calendarDaysAtNineFromIso,
  clampClientActionsToDueDate,
  ensureFeedbackAction,
  ensureInformasjonAction,
  informasjonDueAtFromSignedAt,
  rejectActionAfterDueDate,
} from '../lib/workshop-desk-actions.js';
import {
  workshopDeskEmailAutosendEnabled,
  workshopDeskEmailKindAutosends,
  workshopReminderScheduleAt,
} from '../lib/workshop-desk-emails.js';
import { getAdminCurrentGoalKey } from '../lib/workshop-goal-timeline.js';
import { buildWorkshopReminderEmail, buildDataInnsamlingEmail } from '../lib/sales-email.js';
import { composeEmailForClient } from '../lib/email-templates-store.js';

test('informasjon rings 7 calendar days after signed, weekend to next Monday 09:00 Oslo', () => {
  const thursday = informasjonDueAtFromSignedAt('2026-10-01T12:00:00.000Z');
  assert.match(thursday, /^2026-10-08T/);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Oslo',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(thursday));
  const hour = parts.find((part) => part.type === 'hour')?.value;
  assert.equal(hour, '09');
  const saturdayLand = calendarDaysAtNineFromIso('2026-10-10T12:00:00.000Z', 7);
  assert.match(saturdayLand, /^2026-10-19T/);
});

test('contract signed creates one informasjon ring action', () => {
  const client = {
    progression: { contractSigned: true },
    contractSignedAt: '2026-10-01T12:00:00.000Z',
  };
  const next = ensureInformasjonAction(client);
  assert.equal(next.workshop.goalActions.length, 1);
  assert.equal(next.workshop.goalActions[0].id, INFORMASJON_ACTION_ID);
  assert.equal(next.workshop.goalActions[0].format, 'ring');
  assert.ok(next.workshop.goalActions[0].dueAt);
  const twice = ensureInformasjonAction(next);
  assert.equal(twice.workshop.goalActions.length, 1);
});

test('Få tilbakemelding creates an empty Iterasjon action', () => {
  const next = ensureFeedbackAction({});
  assert.equal(next.workshop.goalActions.length, 1);
  assert.equal(next.workshop.goalActions[0].id, FEEDBACK_ACTION_ID);
  assert.equal(next.workshop.goalActions[0].dueAt, '');
  assert.equal(next.workshop.goalActions[0].goalKey, 'iterated');
});

test('actions after the website due date are rejected and clamped', () => {
  const client = {
    progression: { contractSigned: true },
    contractSignedAt: '2026-10-01T12:00:00.000Z',
    websiteDueOverride: '2026-10-21',
    workshopAction: { name: 'Workshop', format: 'mote', dueAt: '2026-11-01T10:00:00.000Z' },
  };
  assert.match(rejectActionAfterDueDate('2026-11-01T10:00:00.000Z', client), /leveringsfristen/);
  const clamped = clampClientActionsToDueDate(client);
  assert.match(clamped.workshopAction.dueAt, /^2026-10-21T/);
});

test('workshop reminder for Møte includes ICS; SMS/ring does not', () => {
  const mote = buildWorkshopReminderEmail({
    contactPerson: 'Damian',
    contactEmail: 'daracha777@gmail.com',
    businessName: 'Test Bakeri',
    workshopAction: {
      format: 'mote',
      dueAt: '2026-10-15T12:00:00.000Z',
      meetLink: 'https://meet.google.com/aaa-bbbb-ccc',
      calendarEventId: 'evt-ws',
    },
  }, { meetLink: 'https://meet.google.com/aaa-bbbb-ccc', eventId: 'evt-ws' }, '24h');
  assert.match(mote.subject, /workshop/i);
  assert.ok(mote.icalEvent);
  assert.match(mote.icalEvent.content, /METHOD:REQUEST/);
  assert.equal(mote.html.includes('asoldi-envelope'), false);
  const sms = buildWorkshopReminderEmail({
    contactPerson: 'Damian',
    contactEmail: 'daracha777@gmail.com',
    businessName: 'Test Bakeri',
    workshopAction: { format: 'sms-ring', dueAt: '2026-10-15T12:00:00.000Z' },
  }, {}, '3d');
  assert.equal(sms.icalEvent, undefined);
  assert.match(sms.html, /telefon eller SMS/);
});

test('data innsamling lists open need lines', () => {
  const built = buildDataInnsamlingEmail(
    { contactPerson: 'Damian', businessName: 'Test Bakeri' },
    {},
    1,
    { needLines: [{ title: 'Logo', detail: 'Høy oppløsning' }] },
  );
  assert.match(built.html, /Logo/);
  assert.match(built.html, /Høy oppløsning/);
  assert.equal(built.html.includes('asoldi-envelope'), false);
});

test('workshop reminder schedule is 3d and 24h before the workshop', () => {
  const due = '2026-10-15T12:00:00.000Z';
  assert.equal(workshopReminderScheduleAt('3d', due), '2026-10-12T12:00:00.000Z');
  assert.equal(workshopReminderScheduleAt('24h', due), '2026-10-14T12:00:00.000Z');
});

test('desk email autosend is off unless WORKSHOP_DESK_EMAIL_AUTOSEND=1', () => {
  const previous = process.env.WORKSHOP_DESK_EMAIL_AUTOSEND;
  delete process.env.WORKSHOP_DESK_EMAIL_AUTOSEND;
  assert.equal(workshopDeskEmailAutosendEnabled(), false);
  process.env.WORKSHOP_DESK_EMAIL_AUTOSEND = '1';
  assert.equal(workshopDeskEmailAutosendEnabled(), true);
  process.env.WORKSHOP_DESK_EMAIL_AUTOSEND = previous;
  assert.equal(workshopDeskEmailKindAutosends('workshop-reminder-3d'), true);
  assert.equal(workshopDeskEmailKindAutosends('workshop-reminder-24h'), true);
  assert.equal(workshopDeskEmailKindAutosends('data-innsamling-1'), false);
  assert.equal(workshopDeskEmailKindAutosends('data-innsamling-2'), false);
});

test('compose keeps workshop-reminder ICS', () => {
  const composed = composeEmailForClient({
    contactPerson: 'Damian',
    contactEmail: 'daracha777@gmail.com',
    businessName: 'Test Bakeri',
    workshopAction: {
      format: 'mote',
      dueAt: '2026-10-15T12:00:00.000Z',
      meetLink: 'https://meet.google.com/aaa-bbbb-ccc',
      calendarEventId: 'evt-ws',
    },
  }, 'workshop-reminder-24h');
  assert.ok(composed.message.icalEvent);
  assert.match(composed.message.html, /workshop/i);
});

test('held workshop then informasjon is the current Admin goal', () => {
  assert.equal(getAdminCurrentGoalKey({
    workshop: { heldAt: '2026-10-01T10:00:00.000Z', summary: { intro: 'x' } },
  }), 'informasjon');
});
