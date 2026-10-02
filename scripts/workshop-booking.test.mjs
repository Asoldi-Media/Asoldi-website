import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findConnectedCalendarAccountKeysByGoogleEmail } from '../lib/google-calendar.js';
import {
  ADMIN_BOARD_UNBOOKED_BUCKET,
  adminBoardViewerIsDamianMailbox,
  classifyAdminWorkshopBucket,
  clientMatchesAdminBoardFilters,
  filterAdminBoardClients,
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
  assert.equal(classifyAdminWorkshopBucket({ status: 'active', product: 'asoldi', ...decoys }, NOW), ADMIN_BOARD_UNBOOKED_BUCKET);
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
    }, NOW),
    'upcoming',
  );
});

test('no workshopAction sits in Ingen workshop avtalt; action without dueAt is Tid ikke satt', () => {
  const unbooked = { id: 'a', status: 'active', product: 'asoldi', businessName: 'Zulu' };
  const namedNoTime = {
    id: 'b',
    status: 'active',
    product: 'asoldi',
    businessName: 'Alpha',
    workshopAction: { name: 'Workshop', format: 'sms-ring', dueAt: '' },
  };
  const groups = groupAdminBoardClients([namedNoTime, unbooked], NOW);
  assert.deepEqual(groups.unbooked.map((client) => client.id), ['a']);
  assert.deepEqual(groups.noTime.map((client) => client.id), ['b']);
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
  assert.match(salesSrc, /workshopCalendar=1/);

  const adminSrc = readNearby('../app/pages/Admin/sections/AdminBoardSection.tsx');
  assert.match(adminSrc, /workshopCalendar=1/);
  assert.equal(adminSrc.includes('WorkshopNeedsPanel'), false);
  assert.match(adminSrc, /AdminRequestInbox/);
  assert.match(adminSrc, /data-admin-card-actions/);
  assert.match(adminSrc, /WorkshopAdminActionRow/);
  assert.match(adminSrc, /Search and filter/);
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
  assert.equal(clientMatchesAdminBoardFilters(held, { when: 'overdue' }, NOW), true);
  assert.equal(clientMatchesAdminBoardFilters(today, { bucket: 'upcoming' }, NOW), true);
});
