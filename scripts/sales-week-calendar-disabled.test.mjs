import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SALES_WEEK_CALENDAR_DISABLED } from '../lib/google-calendar.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

test('sales list reads offers once and does not stat a video per meeting', () => {
  const server = readFileSync(join(root, 'server.js'), 'utf8');
  const salesGet = server.slice(
    server.indexOf("app.get('/api/admin/sales', salesAuth"),
    server.indexOf("app.get('/api/admin/sales/client-search'")
  );
  assert.match(salesGet, /cachedSalesListRows\(\)/);
  assert.equal(salesGet.includes('getSalesClients'), false);
  assert.equal(salesGet.includes('getOfferForClient'), false);
  assert.equal(salesGet.includes('latestOffersByClient'), false);
  const salesSrc = readFileSync(join(root, 'data/sales.js'), 'utf8');
  const writeSales = salesSrc.slice(salesSrc.indexOf('function writeSalesFile'), salesSrc.indexOf('function emptyReminders'));
  assert.match(writeSales, /salesRevision \+= 1/);
  const offersSrc = readFileSync(join(root, 'data/sales-offers.js'), 'utf8');
  const writeOffers = offersSrc.slice(offersSrc.indexOf('function writeOffersFile'), offersSrc.indexOf('export function normalizeOfferStatus'));
  assert.match(writeOffers, /offersRevision \+= 1/);
  const meetings = readFileSync(join(root, 'lib/workshop-meetings.js'), 'utf8');
  const present = meetings.slice(
    meetings.indexOf('export function presentClientMeetings'),
    meetings.indexOf('export function bookedSlotTimesForMatch')
  );
  assert.equal(present.includes('describeFirefliesMedia'), false);
  assert.match(present, /meetingHasStoredVideo/);
});

test('week calendar Google calls stay off so Admin/Sales list cannot hang Node', () => {
  assert.equal(SALES_WEEK_CALENDAR_DISABLED, true);
  const server = readFileSync(join(root, 'server.js'), 'utf8');
  const salesGet = server.slice(
    server.indexOf("app.get('/api/admin/sales', salesAuth"),
    server.indexOf("app.post('/api/admin/sales/backfill-products'")
  );
  assert.match(salesGet, /getGoogleCalendarStatus\(req\.salesUser\.accountKey\)/);
  assert.equal(salesGet.includes('ensureSharedCalendarTokens'), false);

  const salesUi = readFileSync(join(root, 'app/pages/Admin/sections/SalesClientsSection.tsx'), 'utf8');
  assert.match(salesUi, /toggleHeaderPanel\('calendar'\)/);
  assert.match(salesUi, /\/admin\/sales\/google\/embed/);
  assert.equal(salesUi.includes('/google/events'), false);
  assert.match(salesUi, /if \(headerPanel === 'calendar'\) return;/);

  const calendarUi = readFileSync(join(root, 'app/pages/Admin/sections/SalesCalendarWeek.tsx'), 'utf8');
  assert.match(calendarUi, /<iframe/);
  assert.match(calendarUi, /scrolling="yes"/);
  assert.equal(calendarUi.includes('/google/events'), false);

  const embedRoute = server.slice(
    server.indexOf("app.get('/api/admin/sales/google/embed'"),
    server.indexOf("app.get('/api/admin/sales/google/workshop-availability'")
  );
  assert.equal(embedRoute.includes('SALES_WEEK_CALENDAR_DISABLED'), false);
  assert.equal(embedRoute.includes('loadSalesCalendarWeek'), false);
  assert.equal(embedRoute.includes('prepareSalesCalendarEmbedInner'), false);
  assert.match(embedRoute, /prepareSalesCalendarEmbed/);

  const eventsRoute = server.slice(
    server.indexOf("app.get('/api/admin/sales/google/events'"),
    server.indexOf("app.get('/api/admin/sales/google/embed'")
  );
  assert.match(eventsRoute, /SALES_WEEK_CALENDAR_DISABLED/);

  const adminBoard = readFileSync(join(root, 'app/pages/Admin/sections/AdminBoardSection.tsx'), 'utf8');
  assert.equal(adminBoard.includes('SalesCalendarWeek'), false);
  assert.equal(adminBoard.includes('Kalender for'), false);

  const notes = readFileSync(join(root, 'app/pages/sales/MeetingNotesModal.tsx'), 'utf8');
  assert.equal(notes.includes('SalesCalendarWeek'), false);
  assert.equal(notes.includes('Finn ledig tid'), false);
});

test('GET /admin/sales/offers is not swallowed by /admin/sales/:id', () => {
  const server = readFileSync(join(root, 'server.js'), 'utf8');
  const offersAt = server.indexOf("app.get('/api/admin/sales/offers'");
  const searchAt = server.indexOf("app.get('/api/admin/sales/client-search'");
  const byIdAt = server.indexOf("app.get('/api/admin/sales/:id'");
  assert.ok(offersAt >= 0 && searchAt >= 0 && byIdAt >= 0);
  assert.ok(offersAt < byIdAt);
  assert.ok(searchAt < byIdAt);
});

test('Admin Sales tab keeps the list mounted and retries the client fetch', () => {
  const manage = readFileSync(join(root, 'app/pages/Admin/sections/ManageClientsSection.tsx'), 'utf8');
  assert.match(manage, /opened\.sales/);
  assert.match(manage, /hidden=\{view !== 'sales'\}/);
  assert.match(manage, /active=\{view === 'sales'\}/);
  const salesUi = readFileSync(join(root, 'app/pages/Admin/sections/SalesClientsSection.tsx'), 'utf8');
  assert.match(salesUi, /const backoffMs = \[0, 1200, 3500\]/);
  assert.match(salesUi, /expireFatCookies/);
  assert.match(salesUi, /asoldi-sales-list-v1/);
  assert.equal(salesUi.includes('AbortSignal.timeout(12_000)'), false);
});
