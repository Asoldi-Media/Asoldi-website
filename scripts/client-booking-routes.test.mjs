// Public booking routes on an in-process app (a queryBusy stub) plus one safe-mode hub boot
// for the switch-off answers and the admin iteration route through the shared core.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-booking-routes-'));
process.env.APP_DATA_DIR = DATA_DIR;
delete process.env.DATA_DIR;

const express = (await import('express')).default;
const settingsStore = await import('../data/automation-settings.js');
const sales = await import('../data/sales.js');
const booking = await import('../lib/client-booking.js');
const meetings = await import('../lib/meeting-booking.js');
const routes = await import('../lib/routes/client-booking-routes.js');
const { readDeliveryAudit } = await import('../lib/delivery-audit.js');
const { installSafeMode, resetSafeModeForTests } = await import('../lib/safe-mode.js');
const { bootHub } = await import('./safe-mode/hub-boot.mjs');

// Safe mode so a booking writes the calendar stand-in and the outbox, never a live mailbox.
writeFileSync(join(DATA_DIR, 'google-calendar-tokens.json'), JSON.stringify({
  'admin:damian@asoldi.com': {
    access_token: 'at-test',
    refresh_token: 'rt-test',
    googleEmail: 'damian@asoldi.com',
    scope: 'https://www.googleapis.com/auth/calendar.events',
  },
}));
installSafeMode({ env: { HUB_SAFE_MODE: '1', HUB_SAFE_MODE_ALLOW: '' }, dataDir: DATA_DIR, log: null, egress: false });

test.after(() => {
  resetSafeModeForTests();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

const NOW = Date.parse('2026-11-09T07:00:00.000Z');
const PILOT = 'book-pilot';

function writeSettings(value) {
  const file = join(DATA_DIR, 'automation-settings.json');
  if (value) writeFileSync(file, JSON.stringify(value));
  else rmSync(file, { force: true });
  settingsStore.invalidateAutomationSettingsCache();
}

function autoSettings(pilots = [PILOT]) {
  const defaults = settingsStore.defaultAutomationSettings();
  return {
    ...defaults,
    pilotClientIds: pilots,
    booking: { selfLink: { enabled: true, mode: 'auto', paused: null } },
  };
}

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1');
    server.once('error', reject);
    server.once('listening', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function call(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, body: json };
}

async function appWith(bookingDeps) {
  const app = express();
  app.use(express.json());
  routes.register(app, { sales, bookingDeps: { dataDir: DATA_DIR, now: NOW, ...bookingDeps } });
  return listen(app);
}

sales.createSalesClient({
  id: PILOT,
  product: 'asoldi',
  businessName: 'Fjellbakeriet Example',
  contactPerson: 'Kari Example',
  contactEmail: 'book-pilot@example.com',
  progression: { contractSigned: true },
  status: 'active',
});
sales.createSalesClient({
  id: 'book-ssu',
  product: 'ssu',
  businessName: 'SSU Example',
  contactEmail: 'book-ssu@example.com',
  status: 'active',
});
sales.createSalesClient({
  id: 'book-other',
  product: 'asoldi',
  businessName: 'Other Example',
  contactEmail: 'book-other@example.com',
  progression: { contractSigned: true },
  status: 'active',
});

function tokenFor(clientId, purpose = 'workshop', now = NOW) {
  return booking.createBookingToken({ clientId, purpose }, { dataDir: DATA_DIR, now });
}

test('switch off: both routes answer 404 disabled for a valid token and a bad one, before the token matters', async () => {
  writeSettings(null);
  const { server, base } = await appWith({ queryBusy: async () => ({ ok: true, busy: [] }) });
  try {
    const valid = tokenFor(PILOT);
    const expired = tokenFor(PILOT, 'workshop', NOW - 22 * 24 * 60 * 60 * 1000);
    for (const token of [valid, 'not-a-token', expired]) {
      for (const [method, path] of [['GET', `/api/public/booking/${token}/slots`], ['POST', `/api/public/booking/${token}`]]) {
        const res = await call(base, method, path, method === 'POST' ? { start: '2026-11-10T08:00:00.000Z' } : undefined);
        assert.equal(res.status, 404, `${method} ${token.slice(0, 12)}`);
        assert.equal(res.body.code, 'disabled');
      }
    }
    assert.equal(booking.bookingTokenUsed(booking.verifyBookingToken(valid, { dataDir: DATA_DIR, now: NOW }).nonce, { dataDir: DATA_DIR }), false);
  } finally {
    server.close();
  }
});

test('a valid token lists slots and books one; reuse, tamper, expiry and a taken slot answer as specified', async () => {
  writeSettings(autoSettings());
  const { server, base } = await appWith({ queryBusy: async () => ({ ok: true, busy: [] }) });
  try {
    const token = tokenFor(PILOT);
    const listed = await call(base, 'GET', `/api/public/booking/${token}/slots`);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.purpose, 'workshop');
    assert.equal(listed.body.businessName, 'Fjellbakeriet Example');
    assert.equal(listed.body.durationMinutes, 30);
    assert.equal(listed.body.booked, '');
    assert.ok(listed.body.slots.length > 0);
    assert.equal(JSON.stringify(listed.body).includes('book-pilot@example.com'), false);
    const start = listed.body.slots[0].start;

    const taken = await call(base, 'POST', `/api/public/booking/${token}`, { start: '1999-01-01T00:00:00.000Z' });
    assert.equal(taken.status, 409);
    assert.equal(taken.body.code, 'slot-taken');
    assert.ok(taken.body.slots.length > 0);

    const booked = await call(base, 'POST', `/api/public/booking/${token}`, { start });
    assert.equal(booked.status, 200, JSON.stringify(booked.body));
    assert.equal(booked.body.ok, true);
    assert.equal(booked.body.booking.start, start);
    assert.match(booked.body.rescheduleUrl, /\/book\/v1\./);
    assert.equal(booked.body.rescheduleUrl.endsWith(token), false);
    const audit = readDeliveryAudit({ dataDir: DATA_DIR }).filter((row) => row.kind === 'booking' && row.clientId === PILOT);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].purpose, 'workshop');

    const again = await call(base, 'POST', `/api/public/booking/${token}`, { start });
    assert.equal(again.status, 410);
    assert.equal(again.body.code, 'used');

    const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
    const bad = await call(base, 'GET', `/api/public/booking/${tampered}/slots`);
    assert.equal(bad.status, 404);
    assert.equal(bad.body.code, 'invalid');

    const expired = tokenFor(PILOT, 'iteration', NOW - 22 * 24 * 60 * 60 * 1000);
    const old = await call(base, 'POST', `/api/public/booking/${expired}`, { start });
    assert.equal(old.status, 410);
    assert.equal(old.body.code, 'expired');

    const ssu = await call(base, 'GET', `/api/public/booking/${tokenFor('book-ssu')}/slots`);
    assert.equal(ssu.status, 404);
    assert.equal(ssu.body.code, 'disabled');
    const other = await call(base, 'GET', `/api/public/booking/${tokenFor('book-other')}/slots`);
    assert.equal(other.body.code, 'disabled', 'a client outside the pilot list');
    const unknown = await call(base, 'GET', `/api/public/booking/${tokenFor('missing-client')}/slots`);
    assert.equal(unknown.body.code, 'disabled');
  } finally {
    server.close();
  }
});

test('a calendar that cannot be read answers 503 and releases the token so a later booking can use it', async () => {
  writeSettings(autoSettings());
  let calls = 0;
  const { server, base } = await appWith({
    queryBusy: async () => {
      calls += 1;
      if (calls === 2) return { ok: false, busy: [] };
      return { ok: true, busy: [] };
    },
  });
  try {
    const token = tokenFor(PILOT, 'iteration');
    const failed = await call(base, 'POST', `/api/public/booking/${token}`, { start: meetings.bookingSlots({ now: NOW, purpose: 'iteration' })[0].start });
    assert.equal(failed.status, 503);
    assert.equal(failed.body.code, 'calendar-unavailable');
    assert.match(failed.body.message, /Kalenderen er ikke tilgjengelig/);
    const listed = await call(base, 'GET', `/api/public/booking/${token}/slots`);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const booked = await call(base, 'POST', `/api/public/booking/${token}`, { start: listed.body.slots[0].start });
    assert.equal(booked.status, 200, JSON.stringify(booked.body));
    assert.equal(booked.body.booking.purpose, 'iteration');
  } finally {
    server.close();
  }
});

test('the same address is limited to 30 requests per 10 minutes', async () => {
  writeSettings(autoSettings());
  const { server, base } = await appWith({ queryBusy: async () => ({ ok: true, busy: [] }) });
  try {
    for (let i = 0; i < 30; i += 1) {
      const res = await call(base, 'GET', '/api/public/booking/not-a-token/slots');
      assert.equal(res.status, 404, `request ${i}`);
    }
    const blocked = await call(base, 'GET', '/api/public/booking/not-a-token/slots');
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.code, 'rate-limited');
  } finally {
    server.close();
  }
});

const ROOT_URL = new URL('../', import.meta.url).href;

test('on a booted hub the public routes stay disabled, and the admin iteration route keeps its answers', { timeout: 180_000 }, async () => {
  const seeded = (dir) => {
    const script = join(dir, 'seed-booking.mjs');
    writeFileSync(script, `
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const dir = process.argv[2];
      const at = '2026-10-20T09:00:00.000Z';
      writeFileSync(join(dir, 'sales-clients.json'), JSON.stringify([{
        id: 'iter-1', product: 'asoldi', status: 'active', businessName: 'Fjellbakeriet Example',
        contactPerson: 'Kari Example', contactEmail: 'iter-1@example.com',
        progression: { contractSigned: true }, contractSignedAt: at,
      }], null, 2));
      writeFileSync(join(dir, 'signed-contract-backfill.json'), JSON.stringify({ doneAt: at, sold: 0, files: 0, count: 0 }));
      const store = await import(${JSON.stringify(ROOT_URL + 'data/store.js')});
      await store.setAdminCredentials('booking-admin', 'booking-admin-local-only-7c2a');
      const tokens = await import(${JSON.stringify(ROOT_URL + 'lib/client-booking.js')});
      const token = tokens.createBookingToken({ clientId: 'iter-1', purpose: 'workshop' }, { dataDir: dir, now: Date.parse('2026-11-01T10:00:00.000Z') });
      process.stdout.write(JSON.stringify({ token }));
    `);
    const out = spawnSync(process.execPath, [script, dir], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, APP_DATA_DIR: dir, DATA_DIR: '' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    rmSync(script, { force: true });
    if (out.status !== 0) throw new Error(out.stderr || out.stdout);
    return JSON.parse(out.stdout.trim().split('\n').pop());
  };
  let seed;
  const hub = await bootHub({}, { seed: (dir) => { seed = seeded(dir); } });
  try {
    assert.equal(hub.health?.safeMode, true, hub.log().slice(-1500));
    for (const token of [seed.token, 'not-a-token']) {
      for (const [method, path] of [['GET', `/api/public/booking/${token}/slots`], ['POST', `/api/public/booking/${token}`]]) {
        const res = await call(hub.base, method, path, method === 'POST' ? { start: '2026-11-18T08:00:00.000Z' } : undefined);
        assert.equal(res.status, 404, `${method} ${token.slice(0, 8)}`);
        assert.equal(res.body.code, 'disabled');
      }
    }
    const token = await hub.adminToken('booking-admin', 'booking-admin-local-only-7c2a');
    assert.ok(token, hub.log().slice(-1500));
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const saved = await fetch(`${hub.base}/api/admin/sales/iter-1/workshop/iteration-meeting`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ dueAt: '2026-11-18T08:00:00.000Z', format: 'mote', send: false }),
    });
    const savedBody = await saved.json();
    assert.equal(saved.status, 200, JSON.stringify(savedBody));
    assert.deepEqual(Object.keys(savedBody).sort(), ['client', 'warnings']);
    assert.deepEqual(savedBody.warnings, []);
    assert.equal(savedBody.client.id, 'iter-1');
    assert.equal(savedBody.client.workshop.iterationMeeting.dueAt, '2026-11-18T08:00:00.000Z');
    const missing = await fetch(`${hub.base}/api/admin/sales/iter-1/workshop/iteration-meeting`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ dueAt: '', send: true }),
    });
    const missingBody = await missing.json();
    assert.equal(missing.status, 400);
    assert.equal(missingBody.message, 'Sett tid før du sender iterasjonsmøtet.');
    const stored = JSON.parse(readFileSync(join(hub.dataDir, 'sales-clients.json'), 'utf8')).find((row) => row.id === 'iter-1');
    assert.equal(stored.workshopAction?.dueAt || '', '', 'the public routes did not book a workshop');
  } finally {
    await hub.stop();
  }
});

// ---------------------------------------------------------------- a link that no longer fits the client

const { getWorkshopRecord, mergeWorkshopRecord } = await import('../lib/workshop-record.js');
const { rejectActionAfterDueDate } = await import('../lib/workshop-desk-actions.js');

function signedClient(id, extra = {}) {
  return sales.createSalesClient({
    id,
    product: 'asoldi',
    businessName: `Closed Example ${id}`,
    contactPerson: 'Kari Example',
    contactEmail: `${id}@example.com`,
    status: 'active',
    progression: { contractSigned: true },
    contractSignedAt: '2026-10-20T09:00:00.000Z',
    ...extra,
  });
}

test('a link minted while signed stops booking when the contract is taken back or the plan ended', async () => {
  const ids = ['book-taken-back', 'book-cancelled'];
  for (const id of ids) signedClient(id);
  writeSettings(autoSettings(ids));
  const { server, base } = await appWith({ queryBusy: async () => ({ ok: true, busy: [] }) });
  try {
    const open = tokenFor('book-taken-back');
    assert.equal((await call(base, 'GET', `/api/public/booking/${open}/slots`)).status, 200, 'control: signed, the link works');
    sales.setSalesProgress('book-taken-back', 'contractSigned', false);
    const listed = await call(base, 'GET', `/api/public/booking/${open}/slots`);
    assert.equal(listed.status, 410);
    assert.equal(listed.body.code, 'closed');
    const posted = await call(base, 'POST', `/api/public/booking/${open}`, { start: '2026-11-10T08:00:00.000Z' });
    assert.equal(posted.status, 410);
    assert.equal(booking.bookingTokenUsed(booking.verifyBookingToken(open, { dataDir: DATA_DIR, now: NOW }).nonce, { dataDir: DATA_DIR }), false, 'the token was not spent');

    const cancelled = tokenFor('book-cancelled');
    sales.setSalesDelivery('book-cancelled', { events: { cancelled: { at: '2026-10-25T09:00:00.000Z' }, serviceEndsAt: '2026-11-01T09:00:00.000Z' } }, { by: 'test', reason: 'test' });
    assert.equal((await call(base, 'GET', `/api/public/booking/${cancelled}/slots`)).status, 410);
  } finally {
    server.close();
  }
});

test('a workshop that has been held cannot be booked again from an old link; an iteration link still works', async () => {
  signedClient('book-held');
  writeSettings(autoSettings(['book-held']));
  const c0 = sales.getSalesClientById('book-held');
  sales.setSalesWorkshop('book-held', mergeWorkshopRecord(getWorkshopRecord(c0), { heldAt: '2026-11-02T10:00:00.000Z' }));
  const { server, base } = await appWith({ queryBusy: async () => ({ ok: true, busy: [] }) });
  try {
    const workshop = tokenFor('book-held', 'workshop');
    const res = await call(base, 'POST', `/api/public/booking/${workshop}`, { start: '2026-11-10T08:00:00.000Z' });
    assert.equal(res.status, 410);
    assert.equal(res.body.code, 'held');
    assert.equal(sales.getSalesClientById('book-held').workshopAction?.dueAt || '', '', 'nothing was moved');
    const iteration = await call(base, 'GET', `/api/public/booking/${tokenFor('book-held', 'iteration')}/slots`);
    assert.equal(iteration.status, 200);
  } finally {
    server.close();
  }
});

test('iteration slots after the website due date are not offered, and a rejected pick never shows the staff message', async () => {
  signedClient('book-late', { contractSignedAt: '2026-11-03T09:00:00.000Z', websiteDeliveryWeeks: 1 });
  writeSettings(autoSettings(['book-late']));
  const late = sales.getSalesClientById('book-late');
  const all = meetings.bookingSlots({ now: NOW, purpose: 'iteration' });
  assert.ok(all.some((row) => rejectActionAfterDueDate(row.start, late)), 'control: some slots are after the due date');
  const { server, base } = await appWith({ queryBusy: async () => ({ ok: true, busy: [] }) });
  try {
    const token = tokenFor('book-late', 'iteration');
    const listed = await call(base, 'GET', `/api/public/booking/${token}/slots`);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.ok(listed.body.slots.every((row) => !rejectActionAfterDueDate(row.start, late)));
    const afterDue = all.find((row) => rejectActionAfterDueDate(row.start, late));
    const res = await call(base, 'POST', `/api/public/booking/${token}`, { start: afterDue.start });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'slot-taken');
    assert.equal(JSON.stringify(res.body).includes('leveringsfristen'), false);
  } finally {
    server.close();
  }
});

test('the limiter counts the address the proxy appended, so junk from other visitors does not block a real one', async () => {
  writeSettings(autoSettings());
  const { server, base } = await appWith({ queryBusy: async () => ({ ok: true, busy: [] }) });
  try {
    const hit = (path, ip) => fetch(`${base}${path}`, { headers: { 'x-forwarded-for': ip } }).then((res) => res.status);
    for (let i = 0; i < 31; i += 1) await hit('/api/public/booking/junk/slots', `203.0.113.${i}`);
    assert.equal(await hit(`/api/public/booking/${tokenFor(PILOT, 'iteration')}/slots`, '198.51.100.7'), 200);
    let last = 0;
    for (let i = 0; i < 31; i += 1) last = await hit('/api/public/booking/junk/slots', '203.0.113.99');
    assert.equal(last, 429, 'one address is still limited');
  } finally {
    server.close();
  }
});
