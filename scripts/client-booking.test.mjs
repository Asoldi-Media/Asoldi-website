// Client self-booking: tokens, slots, the link in the pre-workshop mail, and a safe-mode booking.
// Synthetic clients only. APP_DATA_DIR is a fresh temp dir set before any hub import.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-client-booking-'));
process.env.APP_DATA_DIR = DATA_DIR;
delete process.env.DATA_DIR;

const booking = await import('../lib/client-booking.js');
const meetings = await import('../lib/meeting-booking.js');
const mail = await import('../lib/sales-email.js');
const prep = await import('../lib/workshop-prep-send.js');
const settingsStore = await import('../data/automation-settings.js');
const sales = await import('../data/sales.js');
const { readDeliveryAudit } = await import('../lib/delivery-audit.js');
const { osloWallToIso } = await import('../lib/website-due.js');

test.after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

const SENDER = { name: 'Rep', fromEmail: 'rep@asoldi.com', from: 'Rep fra Asoldi <rep@asoldi.com>', replyTo: 'rep@asoldi.com' };
const NOW = Date.parse('2026-03-25T06:00:00.000Z');

function writeSettings(value) {
  const file = join(DATA_DIR, 'automation-settings.json');
  if (value) writeFileSync(file, JSON.stringify(value));
  else rmSync(file, { force: true });
  settingsStore.invalidateAutomationSettingsCache();
}

function bookingSettings(node, pilots = []) {
  const defaults = settingsStore.defaultAutomationSettings();
  return {
    ...defaults,
    pilotClientIds: pilots,
    booking: { selfLink: { ...defaults.booking.selfLink, ...node } },
  };
}

function client(id, extra = {}) {
  return {
    id,
    businessName: 'Fjellbakeriet Example',
    contactPerson: 'Kari Example',
    contactEmail: `${id}@example.com`,
    product: 'asoldi',
    ...extra,
  };
}

test('a token round-trips, a tampered or expired or oversized token does not, and the key file is created once', () => {
  const keyPath = join(DATA_DIR, 'secrets', booking.BOOKING_SECRET_NAME);
  assert.equal(booking.BOOKING_TOKEN_TTL_MS, 21 * 24 * 60 * 60 * 1000);
  const first = booking.createBookingToken({ clientId: 'cli-1', purpose: 'workshop' }, { dataDir: DATA_DIR, now: NOW });
  const key = readFileSync(keyPath);
  assert.ok(key.length >= 32);
  const second = booking.createBookingToken({ clientId: 'cli-1', purpose: 'iteration' }, { dataDir: DATA_DIR, now: NOW });
  assert.deepEqual(readFileSync(keyPath), key, 'the signing key is reused');
  const parts = first.split('.');
  assert.equal(parts.length, 3);
  assert.equal(parts[2].length, second.split('.')[2].length, 'signatures have one length');
  const ok = booking.verifyBookingToken(first, { dataDir: DATA_DIR, now: NOW });
  assert.equal(ok.ok, true);
  assert.equal(ok.clientId, 'cli-1');
  assert.equal(ok.purpose, 'workshop');
  assert.equal(ok.nonce.length, 32);
  const flipped = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -1)}${parts[2].endsWith('a') ? 'b' : 'a'}`;
  assert.deepEqual(booking.verifyBookingToken(flipped, { dataDir: DATA_DIR, now: NOW }), { ok: false, code: 'invalid' });
  const expired = booking.createBookingToken({ clientId: 'cli-1', purpose: 'workshop', ttlMs: 60_000 }, { dataDir: DATA_DIR, now: NOW - 120_000 });
  const late = booking.verifyBookingToken(expired, { dataDir: DATA_DIR, now: NOW });
  assert.equal(late.ok, false);
  assert.equal(late.code, 'expired');
  assert.deepEqual(booking.verifyBookingToken(`v1.${'a'.repeat(700)}`, { dataDir: DATA_DIR, now: NOW }), { ok: false, code: 'invalid' });
  assert.throws(() => booking.createBookingToken({ clientId: 'cli-1', purpose: 'demo' }, { dataDir: DATA_DIR, now: NOW }), /purpose/);
});

test('consumeBookingToken is true once, including from two processes at once, and release frees it', async () => {
  const nonce = randomBytes(16).toString('hex');
  const record = { exp: NOW + 86_400_000, clientId: 'cli-1', purpose: 'workshop', start: '2026-03-26T08:00:00.000Z' };
  assert.equal(booking.consumeBookingToken(nonce, record, { dataDir: DATA_DIR, now: NOW }), true);
  assert.equal(booking.bookingTokenUsed(nonce, { dataDir: DATA_DIR }), true);
  assert.equal(booking.consumeBookingToken(nonce, record, { dataDir: DATA_DIR, now: NOW }), false);
  booking.releaseBookingToken(nonce, { dataDir: DATA_DIR });
  assert.equal(booking.bookingTokenUsed(nonce, { dataDir: DATA_DIR }), false);

  const raced = randomBytes(16).toString('hex');
  const BOOKING_MODULE_URL = new URL('../lib/client-booking.js', import.meta.url).href;
  const child = (name) => new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', `
      const { consumeBookingToken } = await import(${JSON.stringify(BOOKING_MODULE_URL)});
      const won = consumeBookingToken(process.argv[1], { exp: ${NOW + 86_400_000}, clientId: 'cli-2', purpose: 'iteration' }, { dataDir: process.argv[2], now: ${NOW} });
      process.stdout.write(won ? 'yes' : 'no');
    `, raced, DATA_DIR], { env: { ...process.env, APP_DATA_DIR: DATA_DIR } });
    let out = '';
    let err = '';
    proc.stdout.on('data', (chunk) => { out += chunk; });
    proc.stderr.on('data', (chunk) => { err += chunk; });
    proc.on('exit', (code) => (code === 0 ? resolve(out.trim().split('\n').pop()) : reject(new Error(`${name} exit ${code}: ${err.slice(-500)}`))));
  });
  const [a, b] = await Promise.all([child('a'), child('b')]);
  assert.deepEqual([a, b].sort(), ['no', 'yes']);
});

test('slots are the next 10 weekdays, six Oslo hours, across the spring clock change, with busy and past times removed', () => {
  const slots = meetings.bookingSlots({ now: NOW, purpose: 'workshop', busy: [] });
  assert.equal(slots.length, 60, '10 workdays times 6 hours');
  const days = [...new Set(slots.map((slot) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(slot.start))))];
  assert.equal(days.length, 10);
  assert.deepEqual(days.slice(0, 3), ['2026-03-26', '2026-03-27', '2026-03-30']);
  for (const day of days) {
    const weekday = new Date(osloWallToIso(day, 12, 0, 0)).getUTCDay();
    assert.ok(weekday >= 1 && weekday <= 5, day);
  }
  assert.deepEqual(slots.slice(0, 6).map((slot) => slot.start), [
    '2026-03-26T08:00:00.000Z',
    '2026-03-26T09:00:00.000Z',
    '2026-03-26T10:00:00.000Z',
    '2026-03-26T12:00:00.000Z',
    '2026-03-26T13:00:00.000Z',
    '2026-03-26T14:00:00.000Z',
  ]);
  const summer = slots.find((slot) => slot.start === '2026-03-30T07:00:00.000Z');
  assert.ok(summer, '09:00 Oslo after the clocks go forward');
  assert.equal(summer.end, '2026-03-30T07:30:00.000Z');
  const autumnNow = Date.parse('2026-10-22T06:00:00.000Z');
  const autumn = meetings.bookingSlots({ now: autumnNow, purpose: 'iteration', busy: [] });
  assert.ok(autumn.some((slot) => slot.start === '2026-10-23T07:00:00.000Z'), '09:00 still on summer time');
  assert.ok(autumn.some((slot) => slot.start === '2026-10-26T08:00:00.000Z'), '09:00 after the clocks go back');

  const busy = meetings.bookingSlots({
    now: NOW,
    purpose: 'workshop',
    busy: [{ start: '2026-03-26T08:00:00.000Z', end: '2026-03-26T08:30:00.000Z' }],
  });
  assert.equal(busy.some((slot) => slot.start === '2026-03-26T08:00:00.000Z'), false);
  assert.equal(busy.some((slot) => slot.start === '2026-03-26T09:00:00.000Z'), true);

  const during = Date.parse('2026-03-26T08:30:00.000Z');
  const later = meetings.bookingSlots({ now: during, purpose: 'workshop', startInDays: 0, workdays: 1 });
  assert.equal(later.some((slot) => slot.start === '2026-03-26T08:00:00.000Z'), false, '09:00 Oslo is already past');
  assert.equal(later[0].start, '2026-03-26T09:00:00.000Z');
});

test('the link is empty off, in shadow and for a non-pilot, and a url for a pilot in auto', () => {
  const pilot = client('book-pilot');
  const off = bookingSettings({ enabled: false, mode: 'shadow', paused: null }, ['book-pilot']);
  assert.equal(booking.clientBookingLink(pilot, { purpose: 'workshop', settings: off, dataDir: DATA_DIR, now: NOW }), '');
  const shadow = bookingSettings({ enabled: true, mode: 'shadow', paused: null }, ['book-pilot']);
  assert.equal(booking.clientBookingLink(pilot, { purpose: 'workshop', settings: shadow, dataDir: DATA_DIR, now: NOW }), '');
  const shadowRows = readDeliveryAudit({ dataDir: DATA_DIR }).filter((row) => row.kind === 'booking-link-shadow' && row.clientId === 'book-pilot');
  assert.equal(shadowRows.length, 1);
  const auto = bookingSettings({ enabled: true, mode: 'auto', paused: null }, ['someone-else']);
  assert.equal(booking.clientBookingLink(pilot, { purpose: 'workshop', settings: auto, dataDir: DATA_DIR, now: NOW }), '');
  const live = bookingSettings({ enabled: true, mode: 'auto', paused: null }, ['book-pilot']);
  const link = booking.clientBookingLink(pilot, { purpose: 'workshop', settings: live, dataDir: DATA_DIR, now: NOW });
  assert.match(link, /^https:\/\/[^/]+\/book\/v1\./);
  assert.equal(booking.clientBookingLink({ ...pilot, product: 'ssu' }, { settings: live, dataDir: DATA_DIR, now: NOW }), '');
  assert.equal(booking.clientBookingLink({ ...pilot, contactEmail: '' }, { settings: live, dataDir: DATA_DIR, now: NOW }), '');
});

test('the pre-workshop mail is unchanged without a link, and carries the link in auto', async () => {
  const person = client('mail-1');
  const unbooked = mail.buildPreWorkshopEmail(person, {}, { sender: SENDER, hasTime: false, needLines: [] });
  const unbookedEmpty = mail.buildPreWorkshopEmail(person, {}, { sender: SENDER, hasTime: false, needLines: [], bookingLink: '' });
  assert.deepEqual(unbookedEmpty, unbooked);
  const booked = mail.buildPreWorkshopEmail(person, {}, { sender: SENDER, hasTime: true, needLines: [], workshop: { format: 'mote', dueAt: '2026-11-20T08:00:00.000Z' } });
  const bookedEmpty = mail.buildPreWorkshopEmail(person, {}, { sender: SENDER, hasTime: true, needLines: [], workshop: { format: 'mote', dueAt: '2026-11-20T08:00:00.000Z' }, bookingLink: '' });
  assert.deepEqual(bookedEmpty, booked);

  const { installSafeMode, resetSafeModeForTests } = await import('../lib/safe-mode.js');
  const { listOutbox, readOutboxItem } = await import('../lib/safe-mode-outbox.js');
  installSafeMode({ env: { HUB_SAFE_MODE: '1', HUB_SAFE_MODE_ALLOW: '' }, dataDir: DATA_DIR, log: null, egress: false });
  try {
    writeSettings(bookingSettings({ enabled: false, mode: 'shadow', paused: null }));
    const offClient = sales.createSalesClient(client('mail-off'));
    const expected = mail.buildPreWorkshopEmail(offClient, {}, { sender: SENDER, hasTime: false, needLines: [] });
    await prep.sendPrepWorkshopEmail(offClient, { sender: SENDER, needLines: [] });
    const offItems = listOutbox(DATA_DIR, { limit: 20 }).items.filter((item) => (item.to || []).includes('mail-off@example.com'));
    assert.equal(offItems.length, 1);
    const offBody = readOutboxItem(DATA_DIR, offItems[0].id);
    assert.equal(offBody.html, expected.html);
    assert.equal(offBody.text, expected.text);

    writeSettings(bookingSettings({ enabled: true, mode: 'shadow', paused: null }, ['mail-shadow']));
    const shadowClient = sales.createSalesClient(client('mail-shadow'));
    const shadowExpected = mail.buildPreWorkshopEmail(shadowClient, {}, { sender: SENDER, hasTime: false, needLines: [] });
    await prep.sendPrepWorkshopEmail(shadowClient, { sender: SENDER, needLines: [] });
    const shadowItems = listOutbox(DATA_DIR, { limit: 20 }).items.filter((item) => (item.to || []).includes('mail-shadow@example.com'));
    const shadowBody = readOutboxItem(DATA_DIR, shadowItems[0].id);
    assert.equal(shadowBody.html, shadowExpected.html);
    assert.equal(shadowBody.text, shadowExpected.text);
    const shadowAudit = readDeliveryAudit({ dataDir: DATA_DIR }).filter((row) => row.kind === 'booking-link-shadow' && row.clientId === 'mail-shadow');
    assert.equal(shadowAudit.length, 1);

    writeSettings(bookingSettings({ enabled: true, mode: 'auto', paused: null }, ['mail-auto']));
    const autoClient = sales.createSalesClient(client('mail-auto'));
    await prep.sendPrepWorkshopEmail(autoClient, { sender: SENDER, needLines: [] });
    const autoItems = listOutbox(DATA_DIR, { limit: 20 }).items.filter((item) => (item.to || []).includes('mail-auto@example.com'));
    const autoBody = readOutboxItem(DATA_DIR, autoItems[0].id);
    assert.match(autoBody.html, /Velg tid for workshop/);
    assert.match(autoBody.text, /Velg tid: https:\/\/[^/\s]+\/book\/v1\./);
    assert.match(autoBody.html, /Velg en tid som passer i kalenderen/);
    const withLink = mail.buildPreWorkshopEmail(person, { }, {
      sender: SENDER,
      hasTime: true,
      needLines: [],
      workshop: { format: 'mote', dueAt: '2026-11-20T08:00:00.000Z' },
      bookingLink: 'https://asoldi.com/book/v1.example',
    });
    assert.match(withLink.text, /Passer ikke tiden\? Velg en ny tid: https:\/\/asoldi\.com\/book\/v1\.example/);
    assert.match(withLink.html, /Passer ikke tiden\?/);
  } finally {
    resetSafeModeForTests();
  }
});

test('bookIterationMeeting stores a draft and refuses a send without a time; a safe-mode booking records the calendar write and the confirmation', async () => {
  const draft = sales.createSalesClient(client('iter-draft'));
  const saved = await meetings.bookIterationMeeting(draft, { dueAt: '2026-11-18T08:00:00.000Z', format: 'mote', send: false }, {});
  assert.equal(saved.status, 200);
  assert.equal(saved.kick, false);
  assert.deepEqual(saved.payload.warnings, []);
  assert.deepEqual(Object.keys(saved.payload).sort(), ['client', 'warnings']);
  assert.equal(saved.payload.client.workshop.iterationMeeting.dueAt, '2026-11-18T08:00:00.000Z');
  const missing = await meetings.bookIterationMeeting(sales.createSalesClient(client('iter-missing')), { send: true }, {});
  assert.equal(missing.status, 400);
  assert.equal(missing.payload.message, 'Sett tid før du sender iterasjonsmøtet.');

  const { installSafeMode, resetSafeModeForTests, readRecentIntents } = await import('../lib/safe-mode.js');
  const { listOutbox } = await import('../lib/safe-mode-outbox.js');
  installSafeMode({ env: { HUB_SAFE_MODE: '1', HUB_SAFE_MODE_ALLOW: '' }, dataDir: DATA_DIR, log: null, egress: false });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('no network'); };
  try {
    writeFileSync(join(DATA_DIR, 'google-calendar-tokens.json'), JSON.stringify({
      'admin:damian@asoldi.com': {
        access_token: 'at-test',
        refresh_token: 'rt-test',
        googleEmail: 'damian@asoldi.com',
        scope: 'https://www.googleapis.com/auth/calendar.events',
      },
    }));
    const person = sales.createSalesClient(client('iter-book'));
    const slots = meetings.bookingSlots({ now: Date.parse('2026-11-09T07:00:00.000Z'), purpose: 'iteration', busy: [] });
    const result = await meetings.bookSlotForClient(person, { purpose: 'iteration', start: slots[0].start }, {
      now: Date.parse('2026-11-09T07:00:00.000Z'),
      queryBusy: async () => ({ ok: true, busy: [] }),
    });
    assert.equal(result.ok, true, JSON.stringify({ status: result.status, code: result.code, message: result.message }));
    assert.equal(result.booking.purpose, 'iteration');
    assert.equal(result.booking.start, slots[0].start);
    assert.ok(readRecentIntents(30).some((row) => row.kind === 'calendarWrite'));
    const mailed = listOutbox(DATA_DIR, { limit: 30 }).items.filter((item) => (item.to || []).includes('iter-book@example.com'));
    assert.equal(mailed.length, 1);
    assert.match(mailed[0].subject, /iterasjonsmøte/);
  } finally {
    globalThis.fetch = originalFetch;
    resetSafeModeForTests();
  }
});
