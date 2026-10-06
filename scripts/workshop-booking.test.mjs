import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findConnectedCalendarAccountKeysByGoogleEmail } from '../lib/google-calendar.js';
import {
  ADMIN_BOARD_RANKED_BUCKET,
  ADMIN_BOARD_UNBOOKED_BUCKET,
  ADMIN_BOARD_UNLISTED_BUCKET,
  adminBoardViewerIsDamianMailbox,
  classifyAdminWorkshopBucket,
  clientMatchesAdminBoardFilters,
  filterAdminBoardClients,
  getAdminNextActionDueAt,
  getAdminRankMs,
  getWorkshopAction,
  groupAdminBoardClients,
  isAdminBoardCalendarQuery,
  isAdminBoardClient,
  pickDamianCalendarAccountKey,
  resolveAdminBoardCalendarAccountKey,
} from '../lib/workshop-booking.js';
import {
  DAMIAN_CALENDAR_ACCOUNT_KEY,
  DAMIAN_WORKSHOP_CALENDAR_EMAIL,
} from '../lib/workshop-action.js';

const DUE = '2026-10-08T12:00:00.000Z';
const NOW = Date.parse('2026-10-07T12:00:00.000Z');

function readNearby(rel) {
  return readFileSync(new URL(rel, import.meta.url), 'utf8');
}

test('membership includes active non-SSU winners and hand-added clients, including contract-signed', () => {
  const winner = {
    id: 'w1',
    status: 'active',
    product: 'asoldi',
    businessName: 'Winner Bakeri',
    myphoner: { leadId: 'lead-1' },
  };
  const handAdded = {
    id: 'h1',
    status: 'active',
    product: 'asoldi',
    businessName: 'Hand Added AS',
  };
  const signed = {
    ...winner,
    id: 'w2',
    businessName: 'Signed Cafe',
    progression: { contractSigned: true },
  };
  assert.equal(isAdminBoardClient(winner), true);
  assert.equal(isAdminBoardClient(handAdded), true);
  assert.equal(isAdminBoardClient(signed), true);
  const members = filterAdminBoardClients([winner, handAdded, signed]);
  assert.deepEqual(members.map((client) => client.id).sort(), ['h1', 'w1', 'w2']);
});

test('membership excludes SSU, not-sold, and secondary', () => {
  assert.equal(isAdminBoardClient({ status: 'active', product: 'ssu', myphoner: { leadId: 'ssu-1' } }), false);
  assert.equal(isAdminBoardClient({
    status: 'active',
    product: 'ssu',
    progression: { contractSigned: true },
  }), false);
  assert.equal(isAdminBoardClient({ status: 'not-sold', product: 'asoldi', myphoner: { leadId: 'lead-2' } }), false);
  assert.equal(isAdminBoardClient({ status: 'secondary', product: 'asoldi' }), false);
  assert.equal(isAdminBoardClient({ status: 'active', product: 'SSU' }), false);
  assert.deepEqual(filterAdminBoardClients([
    { id: 'ok', status: 'active', product: 'asoldi' },
    { id: 'ssu', status: 'active', product: 'ssu' },
    { id: 'lost', status: 'not-sold', product: 'asoldi' },
    { id: 'sec', status: 'secondary', product: 'asoldi' },
  ]).map((client) => client.id), ['ok']);
});

test('getWorkshopAction ignores startDate, nextActions, and details.workshopAction', () => {
  const decoys = {
    details: {
      meetingQuote: { startDate: '2026-11-01' },
      workshopAction: { name: 'Wrong', format: 'mote', dueAt: DUE },
    },
    nextActions: [{ name: 'Oppfølging', format: 'mote', dueAt: DUE, addToCalendar: true }],
    workshop: { action: { name: 'Held', format: 'mote', dueAt: DUE } },
  };
  assert.equal(getWorkshopAction(decoys), null);
  assert.equal(classifyAdminWorkshopBucket({ status: 'active', product: 'asoldi', ...decoys }), ADMIN_BOARD_UNLISTED_BUCKET);
  const booked = getWorkshopAction({
    ...decoys,
    workshopAction: { name: 'Workshop', format: 'sms-ring', dueAt: DUE, addToCalendar: true },
  });
  assert.equal(booked.format, 'sms-ring');
  assert.equal(booked.dueAt, DUE);
  assert.equal(
    classifyAdminWorkshopBucket({
      status: 'active',
      product: 'asoldi',
      workshopAction: { name: 'Workshop', format: 'mote', dueAt: DUE },
      details: { meetingQuote: { startDate: '2026-01-01' } },
    }),
    ADMIN_BOARD_RANKED_BUCKET,
  );
});

test('unsigned without workshop sits at the bottom; signed without Tid is Ingen workshop avtalt', () => {
  const unlisted = { id: 'a', status: 'active', product: 'asoldi', businessName: 'Zulu' };
  const signedNoTime = {
    id: 'b',
    status: 'active',
    product: 'asoldi',
    businessName: 'Alpha',
    progression: { contractSigned: true },
    contractSignedAt: '2026-09-01T10:00:00.000Z',
    workshopAction: { name: 'Workshop', format: 'sms-ring', dueAt: '' },
  };
  const unsignedWithTid = {
    id: 'c',
    status: 'active',
    product: 'asoldi',
    businessName: 'Bravo',
    workshopAction: { name: 'Workshop', format: 'mote', dueAt: DUE },
  };
  const groups = groupAdminBoardClients([unsignedWithTid, signedNoTime, unlisted], NOW);
  assert.deepEqual(groups.unbooked.map((client) => client.id), ['b']);
  assert.deepEqual(groups.ranked.map((client) => client.id), ['c']);
  assert.deepEqual(groups.unlisted.map((client) => client.id), ['a']);
});

test('unsigned with workshop Tid ranks in the due-date list, not the top bucket', () => {
  assert.equal(classifyAdminWorkshopBucket({
    status: 'active',
    product: 'asoldi',
    workshopAction: { name: 'Workshop', format: 'mote', dueAt: DUE },
  }), ADMIN_BOARD_RANKED_BUCKET);
  assert.equal(classifyAdminWorkshopBucket({
    status: 'active',
    product: 'asoldi',
    progression: { contractSigned: true },
  }), ADMIN_BOARD_UNBOOKED_BUCKET);
});

test('ranked list uses the sooner of due date and next action; untimed sits below', () => {
  const dueSoon = {
    id: 'due-soon',
    status: 'active',
    product: 'asoldi',
    businessName: 'Due Soon',
    progression: { contractSigned: true },
    contractSignedAt: '2026-10-01T08:00:00.000Z',
    websiteDeliveryWeeks: 2,
    workshopAction: { name: 'Workshop', format: 'mote', dueAt: '2026-11-01T10:00:00.000Z' },
  };
  const actionSoon = {
    id: 'action-soon',
    status: 'active',
    product: 'asoldi',
    businessName: 'Action Soon',
    workshopAction: { name: 'Workshop', format: 'mote', dueAt: DUE },
  };
  const untimed = {
    id: 'untimed',
    status: 'active',
    product: 'asoldi',
    businessName: 'Untimed',
    workshopAction: { name: 'Workshop', format: 'mote', dueAt: '2026-10-08T12:00:00.000Z' },
    workshop: {
      heldAt: '2026-10-08T12:30:00.000Z',
      summary: { intro: 'x' },
      iteratedAt: '2026-10-09T12:00:00.000Z',
    },
  };
  const groups = groupAdminBoardClients([untimed, dueSoon, actionSoon], NOW);
  assert.deepEqual(groups.ranked.map((client) => client.id), ['action-soon', 'due-soon', 'untimed']);
  assert.ok(getAdminRankMs(actionSoon) < getAdminRankMs(dueSoon));
  assert.equal(getAdminRankMs(untimed), Number.MAX_SAFE_INTEGER);
});

test('Damian calendar resolver prefers admin:damian@asoldi.com and never falls back to the viewer', () => {
  assert.equal(DAMIAN_WORKSHOP_CALENDAR_EMAIL, 'damian@asoldi.com');
  assert.equal(DAMIAN_CALENDAR_ACCOUNT_KEY, 'admin:damian@asoldi.com');
  assert.equal(pickDamianCalendarAccountKey([]), '');
  assert.equal(
    pickDamianCalendarAccountKey(['sales:other-damian', 'admin:damian@asoldi.com']),
    'admin:damian@asoldi.com',
  );
  assert.equal(
    resolveAdminBoardCalendarAccountKey({
      connectedKeys: [],
      viewerAccountKey: 'sales:alexander',
    }),
    '',
  );
  assert.equal(
    resolveAdminBoardCalendarAccountKey({
      connectedKeys: ['sales:other-damian', 'admin:damian@asoldi.com'],
      viewerAccountKey: 'sales:alexander',
    }),
    'admin:damian@asoldi.com',
  );
  assert.equal(isAdminBoardCalendarQuery({ workshopCalendar: '1' }), true);
  assert.equal(isAdminBoardCalendarQuery({ workshopCalendar: 'true' }), true);
  assert.equal(isAdminBoardCalendarQuery({ ownerId: 'sales:alexander' }), false);
  assert.equal(adminBoardViewerIsDamianMailbox({
    accountKey: 'sales:alexander',
    username: 'alexander@asoldi.com',
  }), false);
  assert.equal(adminBoardViewerIsDamianMailbox({
    accountKey: 'admin:damian@asoldi.com',
    username: 'damian@asoldi.com',
  }), true);
  const liveKeys = findConnectedCalendarAccountKeysByGoogleEmail(DAMIAN_WORKSHOP_CALENDAR_EMAIL);
  assert.equal(Array.isArray(liveKeys), true);
  assert.equal(
    resolveAdminBoardCalendarAccountKey({
      connectedKeys: liveKeys,
      viewerAccountKey: 'sales:alexander',
    }),
    pickDamianCalendarAccountKey(liveKeys),
  );
});

test('booking helper and Admin UI never treat startDate as a booking or copy SalesGoalTimeline', () => {
  const bookingSrc = readNearby('../lib/workshop-booking.js');
  assert.match(bookingSrc, /getWorkshopAction/);
  assert.equal(bookingSrc.includes('meetingQuote'), false);
  assert.equal(bookingSrc.includes('getActiveNextAction'), false);
  assert.equal(bookingSrc.includes('details.workshopAction'), false);

  const salesSrc = readNearby('../app/pages/Admin/sections/SalesClientsSection.tsx');
  assert.match(salesSrc, /ownerId=\{calendarPreviewOwnerId\}/);

  const adminSrc = readNearby('../app/pages/Admin/sections/AdminBoardSection.tsx');
  assert.match(adminSrc, /Ingen workshop avtalt/);
  assert.match(adminSrc, /Ikke listet ennå/);
  assert.match(adminSrc, /AdminRequestInbox/);
  assert.match(adminSrc, /data-admin-card-actions/);
  assert.match(adminSrc, /WorkshopAdminActionRow/);
  assert.match(adminSrc, /clientMatchesAdminBoardFilters/);
  assert.equal(adminSrc.includes('SalesGoalTimeline'), false);
  assert.equal(adminSrc.includes('meetingQuote.startDate'), false);

  const manageSrc = readNearby('../app/pages/Admin/sections/ManageClientsSection.tsx');
  assert.match(manageSrc, /view === 'admin'/);
  assert.match(manageSrc, />\s*Admin\s*</);

  const serverSrc = readNearby('../server.js');
  assert.match(serverSrc, /isAdminBoardCalendarQuery/);
  assert.match(serverSrc, /resolveAdminBoardCalendarAccountKey/);
  assert.match(serverSrc, /findConnectedCalendarAccountKeysByGoogleEmail\(DAMIAN_WORKSHOP_CALENDAR_EMAIL\)/);

  const developerSrc = readNearby('../app/pages/Admin/sections/DevelopmentClientsSection.tsx');
  assert.match(developerSrc, /DeveloperRunQueueBar/);
  const cardSrc = readNearby('../app/pages/developer/DeveloperClientCard.tsx');
  assert.match(cardSrc, /DeveloperRequestThread/);
  assert.equal(developerSrc.includes('DeveloperRequestThread'), false);
});

test('Admin board filters match today, format, and held separately from search', () => {
  const today = {
    id: 'today',
    status: 'active',
    product: 'asoldi',
    businessName: 'Today AS',
    workshopAction: { name: 'Workshop', format: 'mote', dueAt: '2026-10-07T12:00:00.000Z', status: 'confirmed', confirmationSentAt: '2026-10-06T10:00:00.000Z' },
  };
  const sms = {
    id: 'sms',
    status: 'active',
    product: 'asoldi',
    businessName: 'SMS AS',
    workshopAction: { name: 'Workshop', format: 'sms', dueAt: DUE, status: 'draft' },
  };
  const held = {
    id: 'held',
    status: 'active',
    product: 'asoldi',
    businessName: 'Held AS',
    workshopAction: { name: 'Workshop', format: 'mote', dueAt: '2026-10-01T10:00:00.000Z', status: 'confirmed' },
    workshop: { heldAt: '2026-10-01T10:30:00.000Z', summary: { intro: 'x' } },
  };
  assert.equal(clientMatchesAdminBoardFilters(today, { when: 'today' }, NOW), true);
  assert.equal(clientMatchesAdminBoardFilters(sms, { when: 'today' }, NOW), false);
  assert.equal(clientMatchesAdminBoardFilters(today, { format: 'mote' }, NOW), true);
  assert.equal(clientMatchesAdminBoardFilters(sms, { format: 'mote' }, NOW), false);
  assert.equal(clientMatchesAdminBoardFilters(sms, { format: 'sms' }, NOW), true);
  assert.equal(clientMatchesAdminBoardFilters(held, { status: 'held' }, NOW), true);
  assert.equal(clientMatchesAdminBoardFilters(today, { status: 'held' }, NOW), false);
  assert.equal(clientMatchesAdminBoardFilters(today, { status: 'confirmed' }, NOW), true);
  assert.equal(clientMatchesAdminBoardFilters(sms, { status: 'draft' }, NOW), true);
  assert.equal(clientMatchesAdminBoardFilters(today, { bucket: 'ranked' }, NOW), true);
  assert.equal(classifyAdminWorkshopBucket(held), ADMIN_BOARD_RANKED_BUCKET);
});

test('Admin ranks the next action, not only the workshop clock', () => {
  const heldBase = {
    id: 'held-rank',
    status: 'active',
    product: 'asoldi',
    businessName: 'Held Rank AS',
    workshopAction: {
      name: 'Workshop',
      format: 'mote',
      dueAt: '2026-10-01T10:00:00.000Z',
      meetLink: 'https://meet.google.com/old-work-shop',
      status: 'confirmed',
    },
    workshop: { heldAt: '2026-10-01T10:30:00.000Z', summary: { intro: 'x' } },
    calendar: { meetLink: 'https://meet.google.com/idf-xnpu-jna' },
  };
  assert.equal(classifyAdminWorkshopBucket(heldBase), ADMIN_BOARD_RANKED_BUCKET);
  const withIteration = {
    ...heldBase,
    workshop: {
      ...heldBase.workshop,
      iterationMeeting: { format: 'mote', dueAt: DUE, meetLink: 'https://meet.google.com/aaa-bbbb-ccc' },
    },
  };
  assert.equal(getAdminNextActionDueAt(withIteration), DUE);
  const extraSoon = {
    status: 'active',
    product: 'asoldi',
    workshopAction: { name: 'Workshop', format: 'mote', dueAt: DUE },
    workshop: {
      goalActions: [{ id: 'sms', goalKey: 'haWorkshop', dueAt: '2026-10-07T18:00:00.000Z', doneAt: '' }],
    },
  };
  assert.equal(getAdminNextActionDueAt(extraSoon), '2026-10-07T18:00:00.000Z');
});
