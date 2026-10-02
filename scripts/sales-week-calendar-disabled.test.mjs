import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SALES_WEEK_CALENDAR_DISABLED } from '../lib/google-calendar.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

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
  assert.equal(salesUi.includes('SalesCalendarWeek'), false);
  assert.equal(salesUi.includes("toggleHeaderPanel('calendar')"), false);

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
  const salesUi = readFileSync(join(root, 'app/pages/Admin/sections/SalesClientsSection.tsx'), 'utf8');
  assert.match(salesUi, /for \(let attempt = 0; attempt < 3;/);
  assert.equal(salesUi.includes('AbortSignal.timeout(12_000)'), false);
});
