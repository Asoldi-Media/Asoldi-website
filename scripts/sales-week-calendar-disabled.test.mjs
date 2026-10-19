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

test('week calendar events load on open; free-busy stays off so Admin/Sales list cannot hang Node', () => {
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
  assert.match(salesUi, /<SalesCalendarWeek/);
  assert.match(salesUi, /calendarCombined/);
  assert.equal(salesUi.includes("addEventListener('scroll'"), false);
  assert.equal(salesUi.includes('/google/embed'), false);
  assert.equal(salesUi.includes('google/events'), false);

  const calendarUi = readFileSync(join(root, 'app/pages/Admin/sections/SalesCalendarWeek.tsx'), 'utf8');
  assert.match(calendarUi, /admin\/sales\/google\/events/);
  assert.match(calendarUi, /CALENDAR_FETCH_TIMEOUT_MS = 12000/);
  assert.equal(calendarUi.includes('<iframe'), false);
  assert.equal(calendarUi.includes('calendar.google.com'), false);

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
  assert.equal(eventsRoute.includes('SALES_WEEK_CALENDAR_DISABLED'), false);
  assert.match(eventsRoute, /loadSalesCalendarWeek/);
  assert.match(eventsRoute, /overlaySalesMeetingsOnEvents/);
  assert.match(eventsRoute, /withDeadline/);
  assert.equal(eventsRoute.includes('.slice(0, 1)'), false);
  assert.match(eventsRoute, /Ingen selger har koblet Google Calendar/);

  const freeBusyRoute = server.slice(
    server.indexOf("app.get('/api/admin/sales/google/workshop-availability'"),
    server.indexOf("app.get('/api/admin/sales/google/auth-url'")
  );
  assert.match(freeBusyRoute, /SALES_WEEK_CALENDAR_DISABLED/);

  const adminBoard = readFileSync(join(root, 'app/pages/Admin/sections/AdminBoardSection.tsx'), 'utf8');
  assert.match(adminBoard, /SalesCalendarWeek/);
  assert.match(adminBoard, /combined/);
  assert.equal(adminBoard.includes('workshopCalendar'), false);

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

test('sales Details & tools keeps ops tools and skips Kundekort page 1 links', () => {
  const salesUi = readFileSync(join(root, 'app/pages/Admin/sections/SalesClientsSection.tsx'), 'utf8');
  const start = salesUi.indexOf('function renderSalesClientDetails');
  const end = salesUi.indexOf('function renderSalesClientCard');
  assert.ok(start > 0 && end > start);
  const details = salesUi.slice(start, end);
  assert.match(details, /Booket av/);
  assert.match(details, /Vis e-posthandlinger/);
  assert.match(details, /E-post på asoldi\.com/);
  assert.match(details, /Fireflies/);
  assert.match(details, /Gi tilbud/);
  assert.match(details, /openClientFlow\(client, 1\)/);
  assert.match(details, />Handlinger</);
  assert.match(details, /aria-label="Selger"/);
  assert.match(details, /Møtte ikke opp/);
  assert.match(details, /promptSkipMeetingNote/);
  assert.match(details, /Sekundær/);
  assert.match(details, /Ikke solgt/);
  assert.match(details, /Åpne preview/);
  assert.match(details, /Tilbake til salg/);
  assert.equal(details.includes('meetingStarted'), false);
  assert.equal(details.includes('meetingsToday'), false);
  assert.equal(details.includes('category ==='), false);
  assert.equal(details.includes('QuickFill links'), false);
  assert.equal(details.includes('instagramUrl'), false);
  assert.equal(details.includes('facebookUrl'), false);
  assert.equal(details.includes('googleBusinessProfile'), false);
  assert.equal(details.includes('Listen in Sales UI'), false);
});

test('sales focus card header puts Åpne preview next to Rediger', () => {
  const board = readFileSync(join(root, 'app/pages/Admin/sections/SalesFocusBoard.tsx'), 'utf8');
  const rediger = board.indexOf('Rediger');
  const preview = board.indexOf('Åpne preview', rediger);
  const sekundar = board.indexOf('Sekundær', preview);
  assert.ok(rediger > 0 && preview > rediger && sekundar > preview);
});

test('sales focus chips show IRL/Online and skip category-restating labels', () => {
  const board = readFileSync(join(root, 'app/pages/Admin/sections/SalesFocusBoard.tsx'), 'utf8');
  assert.match(board, /function meetingModeLabel/);
  assert.match(board, /<ModeChip client=\{row\.client\} \/>/);
  assert.match(board, /<ModeChip client=\{client\} \/>/);
  assert.equal(board.includes('Mangler selger'), false);
  assert.equal(board.includes('Bekreftelse ikke sendt'), false);
  assert.equal(board.includes("'Klargjør tilbud'"), false);
  assert.equal(board.includes('Venter på signatur'), false);
  assert.match(board, /if \(stepId === 'assign'\) return null;/);
  assert.match(board, /bg-\[#FF5B00\] text-white/);
  assert.match(board, /bg-sky-500 text-white/);
});

test('Tildel selger assigns on select, stays on the tab, and does not toast', () => {
  const board = readFileSync(join(root, 'app/pages/Admin/sections/SalesFocusBoard.tsx'), 'utf8');
  const salesUi = readFileSync(join(root, 'app/pages/Admin/sections/SalesClientsSection.tsx'), 'utf8');
  const server = readFileSync(join(root, 'server.js'), 'utf8');
  const shell = readFileSync(join(root, 'app/pages/Admin/sections/FocusBoardShell.tsx'), 'utf8');
  const panel = board.slice(board.indexOf('function AssignPanel'));
  assert.match(panel, /if \(ownerId\) onAssign\(client, ownerId\)/);
  assert.equal(panel.includes('onClick={() => onAssign'), false);
  assert.match(board, /if \(active === 'assign'\) \{/);
  const ownerFn = salesUi.slice(salesUi.indexOf('async function assignClientOwner'), salesUi.indexOf('function salesMailTemplate'));
  assert.equal(ownerFn.includes('Tildelt. Bekreftelse sendt'), false);
  assert.match(ownerFn, /applySavedClient\(\{ \.\.\.client, ownerId \}\)/);
  const ownerStart = server.indexOf("app.post('/api/admin/sales/:id/owner'");
  const ownerRoute = server.slice(ownerStart, server.indexOf("app.post('/api/admin/sales',", ownerStart + 1));
  assert.match(ownerRoute, /ownerJustAssigned: true/);
  assert.ok(ownerRoute.indexOf('autoSendThankYouFromOwner') < ownerRoute.indexOf('res.json'));
  assert.match(ownerRoute, /thankYouSent: Boolean\(thankYou\?\.sent\)/);
  assert.match(server, /const needsCalendar = previousActions\.some/);
  assert.match(shell, /stayOnLeave\?: boolean/);
  assert.match(readFileSync(join(root, 'app/pages/Admin/sections/DevelopmentClientsSection.tsx'), 'utf8'), /stayOnLeave=\{activeCategory === 'unassigned'\}/);
  assert.match(board, /isAssign \? <AssignPanel \{\.\.\.props\} \/> : null/);
  assert.match(board, /<SalesGoalTimeline/);
  assert.match(board, /Møtte ikke opp/);
  assert.match(board, /Skriv i Notater hvorfor møtet hoppes over/);
  assert.match(salesUi, /fixed inset-0 z-\[100\]/);
  assert.match(salesUi, /if \(event\.key !== 'Escape'\) return;/);
  assert.match(salesUi, /ignoreCreateClickUntilRef/);
  assert.match(salesUi, /pointer-events-none/);
  assert.equal(salesUi.includes('showGoals'), false);
  const nextStart = server.indexOf("app.patch('/api/admin/sales/:id/next-actions'");
  const nextRoute = server.slice(nextStart, server.indexOf("app.post('/api/admin/sales/:id/playbook'"));
  assert.match(nextRoute, /const assigned = isSalesRepAccountKey\(client\.ownerId\)/);
  assert.match(nextRoute, /notifyAttendees: assigned/);
});
