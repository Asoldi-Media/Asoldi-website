// The shared date formatter cache gives the same text as building a new formatter on every call.
// Old results come from reference copies of the earlier code (one new Intl.DateTimeFormat per call).
import test from 'node:test';
import assert from 'node:assert/strict';
import { cachedDateTimeFormat } from '../lib/date-format-cache.js';
import { dayBeforeAtNineIso, isoToDatetimeLocalOslo, nextDayAtNineAmIso, osloWallClockToIso } from '../lib/sales-next-actions.js';
import { baardFarkasCutoffMs } from '../lib/sales-baard-farkas-assign.js';
import { osloCalendarYmd, osloWallToIso } from '../lib/website-due.js';
import { withinMeetingHours } from '../lib/inbox-bot/slots.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const OSLO = 'Europe/Oslo';

// Clocks in Europe/Oslo change at 01:00 UTC on the last Sunday of March and of October.
const DST_CHANGES = [
  Date.UTC(2025, 2, 30, 1), Date.UTC(2025, 9, 26, 1),
  Date.UTC(2026, 2, 29, 1), Date.UTC(2026, 9, 25, 1),
  Date.UTC(2027, 2, 28, 1), Date.UTC(2027, 9, 31, 1),
];

function timestamps() {
  const out = new Set();
  // Every 7 minutes for three days on each side of every clock change.
  for (const change of DST_CHANGES) {
    for (let ms = change - 3 * DAY; ms <= change + 3 * DAY; ms += 7 * 60 * 1000) out.add(ms);
    for (const delta of [-1000, -1, 0, 1, 1000]) out.add(change + delta);
  }
  // A coarse sweep over five years, at a step that drifts through every hour of the day.
  for (let ms = Date.UTC(2024, 0, 1); ms < Date.UTC(2029, 0, 1); ms += 17 * HOUR + 13 * 60 * 1000) out.add(ms);
  // Year ends, a leap day and the epoch.
  for (const ms of [0, Date.UTC(2024, 1, 29, 23, 30), Date.UTC(2025, 11, 31, 22, 59, 59), Date.UTC(2025, 11, 31, 23), Date.UTC(2026, 0, 1)]) out.add(ms);
  return [...out];
}
const STAMPS = timestamps();

// Every locale and option set the callers ask for.
const OPTION_SETS = [
  ['en-CA', { timeZone: OSLO, year: 'numeric', month: '2-digit', day: '2-digit' }],
  ['en-US', { timeZone: OSLO, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }],
  ['en-US', { timeZone: OSLO, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }],
  ['en-GB', { timeZone: OSLO, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }],
  ['en-US', { weekday: 'short', timeZone: OSLO }],
  ['en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: OSLO }],
  ['en-GB', { minute: '2-digit', timeZone: OSLO }],
  ['en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }],
  ['en-CA', { timeZone: undefined, year: 'numeric', month: '2-digit', day: '2-digit' }],
];

// Reference copies of the earlier code: a new formatter on every call.
const toIso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : '');
function oldZonedYmd(ms, timeZone = OSLO) {
  const formatted = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  const [year, month, day] = formatted.split('-').map((part) => Number(part));
  return { year, month, day };
}
function oldZonedDateTimeToUtcMs(year, month, day, hour, minute, timeZone = OSLO) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const parts = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(utcGuess))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0);
  return utcGuess - (asIfUtc - utcGuess);
}
function oldNineOnDay(ms, shift, timeZone = OSLO) {
  const { year, month, day } = oldZonedYmd(ms, timeZone);
  const other = new Date(Date.UTC(year, month - 1, day + shift));
  return toIso(oldZonedDateTimeToUtcMs(other.getUTCFullYear(), other.getUTCMonth() + 1, other.getUTCDate(), 9, 0, timeZone));
}
function oldIsoToDatetimeLocalOslo(ms) {
  const parts = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone: OSLO, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  const pad = (value) => String(value || '').padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}
function oldOsloCalendarYmd(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: OSLO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
function oldOsloDateTimeParts(ms) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: OSLO, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const map = {};
  for (const part of parts) if (part.type !== 'literal') map[part.type] = Number(part.value);
  return map;
}
function oldWithinMeetingHours(ms) {
  const date = new Date(ms);
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: OSLO }).format(date);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: OSLO }).format(date));
  const minute = Number(new Intl.DateTimeFormat('en-GB', { minute: '2-digit', timeZone: OSLO }).format(date));
  return hour >= 8 && (hour < 17 || (hour === 17 && minute === 0));
}

function thrown(fn) {
  try {
    fn();
  } catch (error) {
    return { name: error.name, message: error.message };
  }
  return null;
}

test('a shared formatter gives the same text and the same parts as a new one, for every option set the callers use', () => {
  assert.ok(STAMPS.length > 8000, `expected many timestamps, got ${STAMPS.length}`);
  for (const [locale, options] of OPTION_SETS) {
    const fresh = new Intl.DateTimeFormat(locale, options);
    assert.deepEqual(cachedDateTimeFormat(locale, options).resolvedOptions(), fresh.resolvedOptions());
    for (const ms of STAMPS) {
      const date = new Date(ms);
      const shared = cachedDateTimeFormat(locale, { ...options });
      assert.equal(shared.format(date), fresh.format(date), `${locale} ${JSON.stringify(options)} at ${ms}`);
      assert.deepEqual(shared.formatToParts(date), fresh.formatToParts(date), `${locale} ${JSON.stringify(options)} at ${ms}`);
    }
  }
});

test('the sales, due date and meeting hour helpers answer exactly as the earlier code did, across both clock changes', () => {
  for (const ms of STAMPS) {
    const iso = new Date(ms).toISOString();
    assert.equal(nextDayAtNineAmIso(ms), oldNineOnDay(ms, 1), `next day at nine, ${iso}`);
    assert.equal(dayBeforeAtNineIso(ms), oldNineOnDay(ms, -1), `day before at nine, ${iso}`);
    assert.equal(nextDayAtNineAmIso(ms, 'America/New_York'), oldNineOnDay(ms, 1, 'America/New_York'), `next day at nine in New York, ${iso}`);
    assert.equal(isoToDatetimeLocalOslo(iso), oldIsoToDatetimeLocalOslo(ms), `datetime-local, ${iso}`);
    // A plain ISO string is cut to its date part before any formatter is asked; an HTTP date goes through the formatter.
    const httpDate = new Date(ms).toUTCString();
    assert.equal(osloCalendarYmd(httpDate), oldOsloCalendarYmd(Date.parse(httpDate)), `calendar day, ${httpDate}`);
    assert.equal(withinMeetingHours(iso), oldWithinMeetingHours(ms), `meeting hours, ${iso}`);
  }
});

test('wall clock times on a clock change day, also those that do not exist or happen twice, convert as before', () => {
  const days = [[2026, 3, 29], [2026, 10, 25], [2027, 3, 28], [2027, 10, 31], [2026, 6, 15], [2026, 12, 31]];
  for (const [year, month, day] of days) {
    const ymd = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    for (let hour = 0; hour < 24; hour += 1) {
      for (const minute of [0, 29, 30, 59]) {
        const label = `${ymd} ${hour}:${minute}`;
        assert.equal(osloWallClockToIso(year, month, day, hour, minute), toIso(oldZonedDateTimeToUtcMs(year, month, day, hour, minute)), label);
        // The due date helper looks for the instant whose Oslo wall clock is the one asked for.
        const found = osloWallToIso(ymd, hour, minute, 0);
        const missingHour = month === 3 && hour === 2;
        if (found && !missingHour) {
          const parts = oldOsloDateTimeParts(Date.parse(found));
          assert.deepEqual([parts.year, parts.month, parts.day, parts.hour, parts.minute], [year, month, day, hour, minute], label);
        }
      }
    }
  }
  for (const ymd of ['2026-08-11', '2026-03-29', '2026-10-25']) {
    const [year, month, day] = ymd.split('-').map(Number);
    assert.equal(baardFarkasCutoffMs(ymd), oldZonedDateTimeToUtcMs(year, month, day, 0, 0), ymd);
  }
});

test('an invalid time zone throws the same error as before, on every call', () => {
  const zone = 'Mars/Olympus_Mons';
  const options = { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' };
  const expected = thrown(() => new Intl.DateTimeFormat('en-CA', options));
  assert.equal(expected.name, 'RangeError');
  const at = Date.UTC(2026, 4, 4, 10);
  for (let round = 0; round < 3; round += 1) {
    assert.deepEqual(thrown(() => cachedDateTimeFormat('en-CA', options)), expected);
    assert.deepEqual(thrown(() => nextDayAtNineAmIso(at, zone)), thrown(() => oldNineOnDay(at, 1, zone)));
    assert.deepEqual(thrown(() => dayBeforeAtNineIso(at, zone)), expected);
  }
  // A valid zone asked for afterwards still works.
  assert.equal(nextDayAtNineAmIso(at), '2026-05-05T07:00:00.000Z');
});

test('repeated calls build no new formatter', () => {
  const round = (i) => {
    const ms = Date.UTC(2026, 0, 1) + i * HOUR;
    const iso = new Date(ms).toISOString();
    nextDayAtNineAmIso(ms);
    dayBeforeAtNineIso(ms);
    isoToDatetimeLocalOslo(iso);
    osloCalendarYmd(new Date(ms).toUTCString());
    osloWallToIso('2026-06-15', 9, 0, 0);
    withinMeetingHours(iso);
    baardFarkasCutoffMs();
  };
  round(0);
  const Real = Intl.DateTimeFormat;
  let built = 0;
  Intl.DateTimeFormat = new Proxy(Real, {
    construct(target, args) {
      built += 1;
      return new target(...args);
    },
  });
  try {
    for (let i = 1; i <= 2000; i += 1) round(i);
  } finally {
    Intl.DateTimeFormat = Real;
  }
  assert.equal(built, 0, `${built} formatters were built by 2000 rounds of calls that had all run before`);
});

test('asking for every known time zone keeps the cache bounded and the answers right', () => {
  for (const timeZone of Intl.supportedValuesOf('timeZone')) {
    const options = { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' };
    assert.equal(cachedDateTimeFormat('en-CA', options).format(new Date(0)), new Intl.DateTimeFormat('en-CA', options).format(new Date(0)), timeZone);
  }
  const options = { timeZone: OSLO, year: 'numeric', month: '2-digit', day: '2-digit' };
  assert.equal(cachedDateTimeFormat('en-CA', options).format(new Date(Date.UTC(2026, 5, 15, 22, 30))), '2026-06-16');
});
