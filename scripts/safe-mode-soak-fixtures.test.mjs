// Self-tests of the safe-mode soak fixtures: the invented calendar events, Fireflies meetings and
// inbox messages load, turn into the files the hub reads, and carry nothing real. The soak itself
// (scripts/safe-mode-soak.mjs) boots a hub for minutes and is run by hand before a push.
//
//   node --test scripts/safe-mode-soak-fixtures.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeEgress, seedSoakData } from './safe-mode-soak.mjs';
import {
  buildCalendarClients, buildCalendarTokens, buildFirefliesStore, buildInboxStore, loadSoakFixtures, mailEgress, SOAK_FIXTURE_DIR,
} from './safe-mode-soak-fixtures.mjs';

const NOW = new Date('2026-01-15T10:00:00.000Z');
const temps = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'soak-fixtures-'));
  temps.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('the fixtures load and cover the calendar, Fireflies and inbox', () => {
  const fixtures = loadSoakFixtures();
  assert.ok(fixtures.calendar.events.some((e) => e.mode === 'online'), 'an online meeting (Meet room, Fireflies)');
  assert.ok(fixtures.calendar.events.some((e) => e.mode === 'in-person'));
  assert.ok(fixtures.fireflies.meetings.length >= 2);
  assert.ok(fixtures.inbox.messages.some((m) => m.kind === 'signed_contract'));
  assert.ok(fixtures.inbox.messages.some((m) => m.kind === 'reschedule'));
});

test('the fixtures hold only invented data: example.invalid addresses, no phone numbers, no real hosts', () => {
  const text = readdirSync(SOAK_FIXTURE_DIR).map((name) => readFileSync(join(SOAK_FIXTURE_DIR, name), 'utf8')).join('\n');
  const emails = text.match(/[\w.+-]+@[\w.-]+/g) || [];
  assert.ok(emails.length > 0);
  for (const email of emails) {
    // The inbox bot's own mailbox name is the one address that is not invented; it is a mailbox name, not a person.
    if (email === 'alexander@asoldi.com') continue;
    assert.match(email, /@example\.invalid$/, email);
  }
  assert.doesNotMatch(text, /\+?\d[\d ]{7,}\d/, 'no phone numbers');
  for (const url of text.match(/https?:\/\/[^\s"']+/g) || []) assert.match(url, /^https:\/\/meet\.google\.com\/abc-defg-hij$/, url);
});

test('builders: clients carry a calendar record, meetings are stored by id, inbox mail is handled and nothing is queued to send', () => {
  const fixtures = loadSoakFixtures();
  const clients = buildCalendarClients(fixtures.calendar, NOW);
  assert.equal(clients.length, fixtures.calendar.events.length);
  for (const client of clients) {
    assert.equal(client.status, 'booked');
    assert.ok(Date.parse(client.meetingAt) > NOW.getTime(), 'the meeting is in the future');
    assert.ok(client.calendar.eventId.startsWith('soak-event-'));
    assert.match(client.contactEmail, /@example\.invalid$/);
  }
  assert.equal(clients.find((c) => c.meetingMode === 'online').calendar.meetLink, 'https://meet.google.com/abc-defg-hij');
  assert.equal(clients.find((c) => c.meetingMode === 'in-person').calendar.meetLink, '');
  assert.deepEqual(Object.keys(buildCalendarTokens(fixtures.calendar)), [fixtures.calendar.owner]);

  const store = buildFirefliesStore(fixtures.fireflies, NOW);
  assert.deepEqual(Object.keys(store), fixtures.fireflies.meetings.map((m) => m.meetingId));
  for (const row of Object.values(store)) assert.ok(Date.parse(row.startedAt) < NOW.getTime());

  const inbox = buildInboxStore(fixtures.inbox, NOW);
  assert.equal(inbox.items.length, fixtures.inbox.messages.length);
  assert.deepEqual(inbox.processed, {});
  for (const item of inbox.items) assert.ok(['handled', 'ignored'].includes(item.status), item.status);
});

test('seedSoakData writes the data files the hub reads, on top of the original client', () => {
  const dir = temp();
  const seeded = seedSoakData(dir, NOW);
  assert.equal(seeded.clientId, 'soak-client-1');
  assert.ok(seeded.onlineClientId.startsWith('soak-cal-client-'));
  const clients = JSON.parse(readFileSync(join(dir, 'sales-clients.json'), 'utf8'));
  assert.equal(clients.length, 1 + loadSoakFixtures().calendar.events.length);
  for (const name of ['fireflies-meetings.json', 'inbox-bot.json', 'google-calendar-tokens.json']) {
    assert.doesNotThrow(() => JSON.parse(readFileSync(join(dir, name), 'utf8')), name);
  }
  assert.equal(seeded.meetingIds.length, Object.keys(JSON.parse(readFileSync(join(dir, 'fireflies-meetings.json'), 'utf8'))).length);
});

test('a fixture file that is missing, broken or empty is an error, never an empty soak (control)', () => {
  const dir = temp();
  assert.throws(() => loadSoakFixtures(dir), /cannot be read/);
  for (const name of ['calendar-events.json', 'fireflies-calls.json', 'inbox-messages.json']) {
    writeFileSync(join(dir, name), readFileSync(join(SOAK_FIXTURE_DIR, name)));
  }
  assert.doesNotThrow(() => loadSoakFixtures(dir));
  writeFileSync(join(dir, 'inbox-messages.json'), JSON.stringify({ messages: [] }));
  assert.throws(() => loadSoakFixtures(dir), /lists no messages/);
  writeFileSync(join(dir, 'calendar-events.json'), '{ not json');
  assert.throws(() => loadSoakFixtures(dir), /calendar-events\.json cannot be read/);
});

test('mail egress: a mail port or a mail provider host counts, loopback and the read-only Google hosts do not (control)', () => {
  const hosts = [
    { host: '127.0.0.1', port: 3191 },
    { host: 'www.googleapis.com', port: 443 },
    { host: 'gmail.googleapis.com', port: 443 },
  ];
  assert.deepEqual(mailEgress(hosts), []);
  assert.equal(mailEgress([...hosts, { host: '203.0.113.5', port: 587 }]).length, 1);
  assert.equal(mailEgress([...hosts, { host: 'imap.example.test', port: 443 }]).length, 1);
  assert.equal(mailEgress([...hosts, { host: 'api.resend.com', port: 443 }]).length, 1);
  assert.equal(mailEgress([...hosts, { host: 'smtp.example.test', port: 2525 }]).length, 1);
  const rows = [JSON.stringify({ host: '203.0.113.5', port: 993, listed: false })];
  assert.equal(mailEgress(analyzeEgress(rows).hosts).length, 1);
});

test('the soak fixtures folder is the one the soak reads', () => {
  assert.ok(SOAK_FIXTURE_DIR.endsWith(join('scripts', 'fixtures', 'safe-mode-soak')));
});
