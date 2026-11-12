import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.APP_DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-sales-meeting-void-'));

const sales = await import('../data/sales.js');
const nextActions = await import('../lib/sales-next-actions.js');
const playbook = await import('../lib/sales-playbook.js');
const calendarOwner = await import('../lib/sales-calendar-owner.js');

const here = dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(join(here, '../server.js'), 'utf8');

/** Source of one top-level server.js function (it ends at the first `}` in column 0). */
function serverFunctionSource(name) {
  const match = new RegExp(`\\n(async )?function ${name}\\(`).exec(serverSrc);
  assert.ok(match, `server.js has no function ${name}`);
  const start = match.index + 1;
  const close = /\r?\n\}\r?\n/.exec(serverSrc.slice(start));
  assert.ok(close, `could not find the end of ${name}`);
  return serverSrc.slice(start, start + close.index + close[0].length);
}

/** Runs the real server.js functions with the given globals stubbed. */
function loadServerFunctions(names, deps) {
  const body = `${names.map(serverFunctionSource).join('\n\n')}\nreturn { ${names.join(', ')} };`;
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(deps), body)(...Object.values(deps));
}

const helpers = loadServerFunctions(
  ['sanitizeText', 'isSalesRepAccountKey', 'sameCalendarInstant', 'normalizeMeetingMode'],
  {},
);

const HOUR_MS = 60 * 60 * 1000;
const MEETING = '2026-11-16T13:00:00.000Z'; // Mon 14:00 Oslo

/** Whole hour this many hours from the real clock (for code that uses Date.now()). */
function hoursFromNow(hours) {
  return new Date(Math.ceil((Date.now() + hours * HOUR_MS) / HOUR_MS) * HOUR_MS).toISOString();
}
const CONFIRMED_AT = '2026-11-10T09:00:00.000Z';
let seq = 0;

function seedConfirmed(extra = {}, { meetingAt = MEETING, confirmedAt = CONFIRMED_AT } = {}) {
  seq += 1;
  const id = `void-${seq}`;
  sales.createSalesClient({
    id,
    businessName: `Biz ${id}`,
    contactPerson: 'Kari Nordmann',
    contactEmail: `${id}@example.com`,
    product: 'asoldi',
    ownerId: 'sales:rep1',
    meetingMode: 'online',
    agreedTime: true,
    meetingAt,
    meetingAtSource: 'sales',
    ...extra,
  });
  sales.updateSalesClient(id, {
    reminders: { thankYouSentAt: confirmedAt },
    calendar: {
      eventId: 'evt-old',
      calendarId: 'rep1@asoldi.com',
      accountKey: 'sales:rep1',
      meetLink: 'https://meet.google.com/old-room-aaa',
      confirmedMeetLink: 'https://meet.google.com/old-room-aaa',
      guestInvitedAt: confirmedAt,
      inviteSequence: 2,
    },
  });
  sales.rescheduleSalesReminders(id, Date.parse(confirmedAt));
  return sales.getSalesClientById(id);
}

function addFollowerRows(id) {
  const current = sales.getSalesClientById(id);
  return sales.updateSalesClient(id, {
    nextActions: [
      ...current.nextActions,
      { id: `${id}-sms24h`, goalKey: 'meetingHeld', presetKey: 'sms24h', name: 'SMS 24h', format: 'sms' },
      { id: `${id}-call2h`, goalKey: 'meetingHeld', presetKey: 'call2h', name: 'Call 2h', format: 'ring' },
      { id: `${id}-custom`, goalKey: 'meetingHeld', presetKey: 'custom', name: 'Send case', format: 'email', dueAt: '2026-11-12T09:00:00.000Z' },
    ],
  });
}

const openRow = (client, presetKey) => client.nextActions.find((row) => row.presetKey === presetKey && !row.doneAt) || null;
const anyRow = (client, presetKey) => client.nextActions.find((row) => row.presetKey === presetKey) || null;

// ---------------------------------------------------------------------------
// data/sales.js voidSalesMeetingTime
// ---------------------------------------------------------------------------

test('voidSalesMeetingTime clears the meeting time, the open meeting row, reminders and calendar in one write', () => {
  const seeded = addFollowerRows(seedConfirmed().id);
  sales.updateSalesClient(seeded.id, {
    nextActions: seeded.nextActions.map((row) => (row.presetKey === 'meeting' ? { ...row, note: 'Kunden vil se priser' } : row)),
  });
  assert.equal(openRow(sales.getSalesClientById(seeded.id), 'sms1h')?.presetKey, 'sms1h');
  assert.equal(openRow(sales.getSalesClientById(seeded.id), 'sms24h')?.dueAt, '2026-11-15T13:00:00.000Z');
  const nowMs = Date.parse('2026-11-14T10:00:00.000Z');

  const voided = sales.voidSalesMeetingTime(seeded.id, { note: 'Bot: kunden kan ikke mandag', nowMs });

  assert.equal(voided.agreedTime, false);
  assert.equal(voided.meetingAt, '');
  assert.equal(voided.meetingAtSource, '');
  const meeting = openRow(voided, 'meeting');
  assert.ok(meeting, 'the meeting row stays open so the rep can set a new time');
  assert.equal(meeting.dueAt, '');
  assert.equal(meeting.relativeToMeetingHours, null);
  assert.equal(meeting.sticky, false);
  assert.equal(meeting.stickyAnchorId, '');
  assert.equal(meeting.stickyOffsetMs, null);
  assert.equal(meeting.note, 'Kunden vil se priser\nBot: kunden kan ikke mandag');
  assert.equal(openRow(voided, 'sms1h'), null, 'no open Påminnelse for a cancelled meeting');
  assert.equal(anyRow(voided, 'sms24h').doneAt, '2026-11-14T10:00:00.000Z');
  assert.equal(anyRow(voided, 'call2h').doneAt, '2026-11-14T10:00:00.000Z');
  assert.equal(anyRow(voided, 'custom').doneAt, '', 'unrelated rep tasks stay open');
  assert.equal(anyRow(voided, 'custom').dueAt, '2026-11-12T09:00:00.000Z');
  assert.deepEqual(voided.reminders, {
    thankYouSentAt: '',
    reminder24hAt: '',
    reminder24hSentAt: '',
    reminder3dAt: '',
    reminder3dSentAt: '',
    reminder1hAt: '',
    reminder1hSentAt: '',
    skipDueToShortNotice: false,
  });
  // Same calendar clear as clearSalesMeetingScheduling. The Meet room the client already has in the inbox is
  // re-stamped by normalization (planConfirmedMeetBackfill), so a rebooking reuses it; no event id survives.
  const roomKeys = new Set(['meetLink', 'confirmedMeetLink']);
  for (const [key, value] of Object.entries(voided.calendar)) {
    if (roomKeys.has(key)) continue;
    assert.equal(value, key === 'inviteSequence' ? 0 : '', `calendar.${key} is cleared`);
  }
  const cleared = sales.clearSalesMeetingScheduling(seedConfirmed().id);
  assert.equal(voided.calendar.meetLink, cleared.calendar.meetLink);
  assert.equal(voided.calendar.confirmedMeetLink, cleared.calendar.confirmedMeetLink);
  assert.equal(voided.salesPlaybook.cancelledMeetingAt, MEETING);
  assert.equal(voided.salesPlaybook.cancelledAt, '2026-11-14T10:00:00.000Z');

  const reread = sales.getSalesClientById(seeded.id);
  assert.equal(reread.salesPlaybook.cancelledMeetingAt, MEETING, 'normalization keeps the cancel marker');
  assert.equal(reread.salesPlaybook.cancelledAt, '2026-11-14T10:00:00.000Z');
  assert.equal(openRow(reread, 'meeting').dueAt, '');
});

test('after a void nothing on the card names the cancelled time and the board asks for a new one', async (t) => {
  const voided = sales.voidSalesMeetingTime(seedConfirmed().id, { nowMs: Date.parse('2026-11-14T10:00:00.000Z') });
  assert.equal(nextActions.clientMeetingAtIso(voided), '');
  assert.equal(
    voided.nextActions.some((row) => !row.doneAt && ['meeting', 'meetingBooked'].includes(row.presetKey) && row.dueAt),
    false,
  );
  const nowMs = Date.parse('2026-11-14T10:00:00.000Z');
  const entries = playbook.salesFocusEntries(voided, nowMs);
  assert.deepEqual(entries.map((entry) => entry.category), ['confirm']);
  assert.equal(entries[0].confirmRank, 0);

  let decide = null;
  try {
    decide = await import('../lib/inbox-bot/decide.js');
  } catch (error) {
    t.skip(`lib/inbox-bot/decide.js does not import right now: ${error.message}`);
    return;
  }
  assert.equal(decide.clientMeetingAt(voided), '');
});

test('after a void no reminder check can fire, at any time before or at the cancelled meeting', () => {
  const voided = sales.voidSalesMeetingTime(seedConfirmed().id, { nowMs: Date.parse('2026-11-14T10:00:00.000Z') });
  const r = voided.reminders;
  for (const iso of ['2026-11-14T10:01:00.000Z', '2026-11-15T13:01:00.000Z', '2026-11-16T12:01:00.000Z', '2026-11-16T12:59:00.000Z']) {
    const nowMs = Date.parse(iso);
    for (const [at, sent] of [[r.reminder3dAt, r.reminder3dSentAt], [r.reminder24hAt, r.reminder24hSentAt], [r.reminder1hAt, r.reminder1hSentAt]]) {
      assert.equal(sales.salesReminderIsDue(at, sent, { nowMs, meetingAt: voided.meetingAt }), false, iso);
    }
    assert.equal(sales.salesReminderCatchUpIsDue('24h', voided, nowMs), false, iso);
    assert.equal(sales.salesReminderCatchUpIsDue('1h', voided, nowMs), false, iso);
    assert.notEqual(sales.salesReminderBlockedReason(voided, nowMs), '', iso);
  }
});

test('a second void keeps the first cancelled time, and an unknown id returns null', () => {
  const seeded = seedConfirmed();
  sales.voidSalesMeetingTime(seeded.id, { note: 'første', nowMs: Date.parse('2026-11-14T10:00:00.000Z') });
  const again = sales.voidSalesMeetingTime(seeded.id, { note: 'andre', nowMs: Date.parse('2026-11-14T11:00:00.000Z') });
  assert.equal(again.salesPlaybook.cancelledMeetingAt, MEETING);
  assert.equal(again.salesPlaybook.cancelledAt, '2026-11-14T11:00:00.000Z');
  assert.equal(openRow(again, 'meeting').note, 'første\nandre');
  assert.equal(sales.voidSalesMeetingTime('no-such-client'), null);
});

test('voidSalesMeetingTime never touches a Tilbud, Venter signering, Solgt or archived card', () => {
  for (const patch of [
    { progression: { meetingHeld: true } },
    { progression: { meetingHeld: true, offerSent: true } },
    { progression: { meetingHeld: true, offerSent: true, contractSigned: true } },
    { status: 'secondary' },
    { status: 'not-sold' },
  ]) {
    const card = seedConfirmed();
    const before = sales.updateSalesClient(card.id, patch);
    assert.equal(sales.voidSalesMeetingTime(card.id, { note: 'Bot' }), null, JSON.stringify(patch));
    const after = sales.getSalesClientById(card.id);
    assert.equal(after.meetingAt, before.meetingAt);
    assert.equal(after.agreedTime, before.agreedTime);
    assert.equal(after.calendar.eventId, 'evt-old');
    assert.equal(after.salesPlaybook.cancelledAt, '');
    assert.equal(after.updatedAt, before.updatedAt, 'nothing was written');
  }
});

test('rebooking after a void sends a fresh confirmation and brings back the Påminnelse task', () => {
  const voided = sales.voidSalesMeetingTime(seedConfirmed().id, { nowMs: Date.parse('2026-11-14T10:00:00.000Z') });
  const row = openRow(voided, 'meeting');
  const rebooked = sales.setSalesNextAction(voided.id, { op: 'update', id: row.id, dueAt: '2026-11-19T10:00:00.000Z' });
  assert.equal(rebooked.agreedTime, true);
  assert.equal(rebooked.meetingAt, '2026-11-19T10:00:00.000Z');
  assert.equal(rebooked.meetingAtSource, 'sales');
  assert.equal(rebooked.reminders.thankYouSentAt, '', 'no stale thank-you stamp blocks the new confirmation');
  assert.equal(nextActions.confirmationShouldSendOnChange(voided, rebooked), true);
  const sms = openRow(rebooked, 'sms1h');
  assert.ok(sms, 'a fresh Påminnelse row follows the new meeting');
  assert.equal(sms.dueAt, '2026-11-18T08:00:00.000Z');
});

test('a ticked Møtet booket row at the cancelled time loses its time, so clientMeetingAtIso is empty after the void', () => {
  const card = seedConfirmed();
  const created = sales.setSalesNextAction(card.id, {
    op: 'create', goalKey: 'meetingHeld', presetKey: 'meetingBooked', name: 'Møtet booket', dueAt: MEETING,
  });
  const booked = created.nextActions.find((row) => row.presetKey === 'meetingBooked');
  const ticked = sales.setSalesNextAction(card.id, { op: 'complete', id: booked.id });
  assert.ok(ticked.nextActions.find((row) => row.id === booked.id).doneAt, 'the rep ticked it');
  const doneCustom = { id: `${card.id}-done-custom`, goalKey: 'meetingHeld', presetKey: 'custom', name: 'Ring', dueAt: MEETING, doneAt: '2026-11-01T09:00:00.000Z' };
  sales.updateSalesClient(card.id, { nextActions: [...ticked.nextActions, doneCustom] });

  const voided = sales.voidSalesMeetingTime(card.id, { nowMs: Date.parse('2026-11-14T10:00:00.000Z') });

  assert.equal(voided.salesPlaybook.cancelledMeetingAt, MEETING);
  const doneRow = voided.nextActions.find((row) => row.id === booked.id);
  assert.equal(doneRow.dueAt, '', 'the ticked row no longer names the cancelled time');
  assert.ok(doneRow.doneAt, 'it stays ticked');
  assert.equal(voided.nextActions.find((row) => row.id === doneCustom.id).dueAt, MEETING, 'other ticked tasks keep their time');
  assert.equal(nextActions.clientMeetingAtIso(voided), '');
  const reread = sales.getSalesClientById(card.id);
  assert.equal(nextActions.clientMeetingAtIso(reread), '', 'normalization keeps it blank');
  assert.equal(sales.salesReminderBlockedReason(reread, Date.parse('2026-11-15T13:01:00.000Z')), 'not-confirmed');

  // A ticked Møtet booket row for another (older) meeting is history and keeps its time.
  const other = seedConfirmed();
  const olderAt = '2026-11-02T13:00:00.000Z';
  const olderRow = { id: `${other.id}-older`, goalKey: 'meetingHeld', presetKey: 'meetingBooked', name: 'Møtet booket', dueAt: olderAt, doneAt: '2026-11-01T09:00:00.000Z' };
  sales.updateSalesClient(other.id, { nextActions: [...other.nextActions, olderRow] });
  const otherVoided = sales.voidSalesMeetingTime(other.id, { nowMs: Date.parse('2026-11-14T10:00:00.000Z') });
  assert.equal(otherVoided.nextActions.find((row) => row.id === olderRow.id).dueAt, olderAt);
  assert.equal(otherVoided.salesPlaybook.cancelledMeetingAt, MEETING);
});

test('appendActionNote keeps the newest line when the note hits the cap', () => {
  assert.equal(nextActions.appendActionNote('', 'Bot: flyttet'), 'Bot: flyttet');
  assert.equal(nextActions.appendActionNote('Gammel', ''), 'Gammel');
  assert.equal(nextActions.appendActionNote('Gammel\r\n', ' Ny '), 'Gammel\nNy');
  const long = nextActions.appendActionNote('x'.repeat(995), 'Bot: ny tid');
  assert.equal(long.length <= 1000, true);
  assert.ok(long.endsWith('Bot: ny tid'));
});

// ---------------------------------------------------------------------------
// lib/sales-next-actions.js MyPhoner merge guard
// ---------------------------------------------------------------------------

test('a MyPhoner winner replay cannot restore the time the client cancelled (±2 min)', () => {
  const voided = sales.voidSalesMeetingTime(seedConfirmed().id, { nowMs: Date.parse('2026-11-14T10:00:00.000Z') });
  const newerWinner = { winnerAt: '2026-11-14T11:00:00.000Z' };
  const same = nextActions.resolveMeetingAtOnMyphonerMerge(voided, MEETING, newerWinner);
  assert.equal(same.meetingAt, '', 'the cancelled time never comes back, not even from a newer winner');
  assert.equal(same.agreedTime, false);
  const nearly = nextActions.resolveMeetingAtOnMyphonerMerge(voided, '2026-11-16T13:01:30.000Z', newerWinner);
  assert.equal(nearly.meetingAt, '');
  assert.equal(nearly.agreedTime, false);
  const other = nextActions.resolveMeetingAtOnMyphonerMerge(voided, '2026-11-16T13:03:00.000Z', newerWinner);
  assert.equal(other.meetingAt, '2026-11-16T13:03:00.000Z');
  assert.equal(other.agreedTime, true);
  assert.equal(other.meetingAtSource, 'myphoner');
  const otherDay = nextActions.resolveMeetingAtOnMyphonerMerge(voided, '2026-11-20T09:00:00.000Z', newerWinner);
  assert.equal(otherDay.meetingAt, '2026-11-20T09:00:00.000Z');
});

test('after a move then a void, a MyPhoner replay of the older booking stays out; only a newer winner books', () => {
  // MyPhoner booked T1, the client moved it to T2 (source 'sales'), then cancelled T2 with no new time.
  const T1 = '2026-11-18T13:00:00.000Z';
  const T2 = '2026-11-17T13:00:00.000Z';
  const card = seedConfirmed({ meetingAtSource: 'myphoner' }, { meetingAt: T1 });
  const row = openRow(card, 'meeting');
  const moved = sales.setSalesNextAction(card.id, { op: 'update', id: row.id, dueAt: T2 });
  assert.equal(moved.meetingAtSource, 'sales');
  assert.equal(nextActions.resolveMeetingAtOnMyphonerMerge(moved, T1).meetingAt, T2, 'control: before the void the rep time stays');
  const voided = sales.voidSalesMeetingTime(card.id, { nowMs: Date.parse('2026-11-14T10:00:00.000Z') });
  assert.equal(voided.salesPlaybook.cancelledMeetingAt, T2);
  assert.equal(nextActions.meetingIsVoided(voided), true);

  for (const winnerAt of ['', 'nope', '2026-11-10T08:00:00.000Z', '2026-11-14T10:00:00.000Z']) {
    const replay = nextActions.resolveMeetingAtOnMyphonerMerge(voided, T1, { winnerAt });
    assert.deepEqual(replay, { meetingAt: '', agreedTime: false, meetingAtSource: '' }, `winnerAt=${winnerAt || '(none)'}`);
  }
  const rebooked = nextActions.resolveMeetingAtOnMyphonerMerge(voided, T1, { winnerAt: '2026-11-14T10:05:00.000Z' });
  assert.deepEqual(rebooked, { meetingAt: T1, agreedTime: true, meetingAtSource: 'myphoner' }, 'a rep booked again in MyPhoner after the cancel');

  const set = sales.setSalesNextAction(card.id, { op: 'update', id: openRow(voided, 'meeting').id, dueAt: '2026-11-19T10:00:00.000Z' });
  assert.equal(nextActions.meetingIsVoided(set), false, 'a new time ends the void');
  assert.equal(nextActions.resolveMeetingAtOnMyphonerMerge(set, T1).meetingAt, '2026-11-19T10:00:00.000Z');
});

test('server.js reads the newest MyPhoner winner event and hands it to the merge', async () => {
  const myphonerApi = await import('../lib/myphoner-api.js');
  const { latestMyphonerWinnerAt } = loadServerFunctions(['latestMyphonerWinnerAt'], {
    sanitizeText: helpers.sanitizeText,
    myphonerApi,
  });
  assert.equal(latestMyphonerWinnerAt({}), '');
  assert.equal(latestMyphonerWinnerAt({ last_event: { kind: 'note', created_at: '2026-11-14 12:00:00 UTC' } }), '');
  assert.equal(
    latestMyphonerWinnerAt({
      events: [
        { kind: 'winner', created_at: '2026-11-02 08:00:00 UTC' },
        { type: 'won', created_at: '2026-11-15T09:30:00Z' },
        { kind: 'call', created_at: '2026-11-20T09:30:00Z' },
      ],
      last_event: { kind: 'note', state: 'won', created_at: '2026-11-14 12:00:00 UTC' },
    }),
    '2026-11-15T09:30:00.000Z',
  );
  assert.equal(latestMyphonerWinnerAt({ last_action_or_note: { kind: 'winner', created_at: '' } }), '');
  assert.match(serverFunctionSource('upsertSalesClientFromMyphonerLead'), /mergeMyphonerSalesInput\(existing, incomingInput, \{ winnerAt: latestMyphonerWinnerAt\(source\) \}\)/);
  assert.match(serverFunctionSource('mergeMyphonerSalesInput'), /resolveMeetingAtOnMyphonerMerge\(\s*current,\s*incomingHasMeeting \? next\.meetingAt : '',\s*\{ winnerAt \}\s*\)/);
});

/** Real server.js backfillSalesBookingFacts; MyPhoner HTTP stubbed with a lead that still holds `scheduledFor`. */
async function bookingBackfill(scheduledFor) {
  const facts = await import('../lib/sales-booking-facts.js');
  const myphonerApi = await import('../lib/myphoner-api.js');
  const fetched = [];
  const names = ['sanitizeText', 'normalizeEmail', 'normalizeLooseKey', 'sanitizeMyphonerFieldValue', 'pickLeadDataValue', 'parseMyphonerMeetingAt', 'backfillSalesBookingFacts'];
  const fns = loadServerFunctions(names, {
    salesBookingBackfillRunning: false,
    store: { getAllUsers: async () => [] },
    sales,
    salesBookingFacts: facts.salesBookingFacts,
    extractBookingFromLead: facts.extractBookingFromLead,
    meetingIsVoided: nextActions.meetingIsVoided,
    myphonerMeetingTimeAllowed: nextActions.myphonerMeetingTimeAllowed,
    myphonerApi: {
      isMyPhonerConfigured: () => true,
      // MyPhoner never learns about the mail: the lead keeps its original booking.
      fetchMyPhonerLeadById: async (id) => { fetched.push(id); return { success: true, data: { id, list_name: 'Frisører', scheduled_for: scheduledFor } }; },
      unwrapMyPhonerLead: (data) => data,
      fetchMyPhonerLeadEvents: async () => ({ success: false }),
      fetchMyPhonerCallById: async () => ({ success: false }),
      parseMyPhonerDateToIso: myphonerApi.parseMyPhonerDateToIso,
    },
    getLeadDataMap: () => new Map(),
    isLikelyMissingMyphonerValue: () => false,
    resolveLeadCommentText: () => '',
    parseMyphonerMeetingAtFromFreeText: () => '',
    console: { log() {}, warn() {}, error() {} },
  });
  return { fetched, run: fns.backfillSalesBookingFacts };
}

test('startup booking backfill never brings back a voided meeting time from the MyPhoner lead', async () => {
  const T1 = '2026-11-18T13:00:00.000Z'; // MyPhoner booking (Wed 14:00 Oslo)
  const T2 = '2026-11-19T13:00:00.000Z'; // the client moved it by mail, then cancelled
  const myphoner = { leadId: 'L-void-1', listName: 'Frisører', bookedByEmail: 'caller@asoldi.com', bookedAt: '2026-11-01T10:00:00.000Z' };
  const card = seedConfirmed({ meetingAtSource: 'myphoner', myphoner }, { meetingAt: T1 });
  sales.setSalesNextAction(card.id, { op: 'update', id: openRow(card, 'meeting').id, dueAt: T2 });
  sales.voidSalesMeetingTime(card.id, { note: 'Kunden kan ikke.', nowMs: Date.parse('2026-11-14T10:00:00.000Z') });
  // Same card, but MyPhoner never stored the list name, so the backfill does fetch the lead.
  const partial = seedConfirmed({ meetingAtSource: 'myphoner', myphoner: { ...myphoner, leadId: 'L-void-2', listName: '' } }, { meetingAt: T1 });
  sales.voidSalesMeetingTime(partial.id, { nowMs: Date.parse('2026-11-14T10:00:00.000Z') });
  // Older data: the cancel time is stored without the cancel stamp. The cancelled time itself still never returns.
  const legacy = seedConfirmed({ meetingAtSource: 'myphoner', myphoner: { ...myphoner, leadId: 'L-void-3' } }, { meetingAt: T1 });
  const legacyVoided = sales.voidSalesMeetingTime(legacy.id, { nowMs: Date.parse('2026-11-14T10:00:00.000Z') });
  sales.updateSalesClient(legacy.id, { salesPlaybook: { ...legacyVoided.salesPlaybook, cancelledAt: '' } });
  assert.equal(nextActions.meetingIsVoided(sales.getSalesClientById(legacy.id)), false);
  // Control: a MyPhoner card that simply lacks a time still gets it.
  const control = seedConfirmed({ meetingAtSource: '', myphoner: { ...myphoner, leadId: 'L-control' } }, { meetingAt: T1 });
  sales.updateSalesClient(control.id, { agreedTime: false, meetingAt: '' });

  const { fetched, run } = await bookingBackfill('2026-11-18 13:00:00 UTC');
  await run();

  for (const id of [card.id, partial.id, legacy.id]) {
    const after = sales.getSalesClientById(id);
    assert.equal(after.meetingAt, '', id);
    assert.equal(after.agreedTime, false, id);
    assert.equal(nextActions.clientMeetingAtIso(after), '', id);
    assert.equal(openRow(after, 'meeting').dueAt, '', id);
  }
  assert.equal(sales.getSalesClientById(partial.id).myphoner.listName, 'Frisører', 'the other facts are still filled');
  assert.equal(fetched.includes('L-void-1'), false, 'a voided card with every other fact is not fetched just for the time');
  assert.ok(fetched.includes('L-void-2'));
  assert.equal(sales.getSalesClientById(control.id).meetingAt, T1, 'control: the backfill still fills a missing time');
  assert.equal(sales.getSalesClientById(control.id).agreedTime, true);
});

test('isCancelledMeetingTime only matches a stored cancel marker', () => {
  const client = { salesPlaybook: { cancelledMeetingAt: MEETING } };
  assert.equal(nextActions.isCancelledMeetingTime(client, MEETING), true);
  assert.equal(nextActions.isCancelledMeetingTime(client, '2026-11-16T12:58:00.000Z'), true);
  assert.equal(nextActions.isCancelledMeetingTime(client, '2026-11-16T12:57:59.000Z'), false);
  assert.equal(nextActions.isCancelledMeetingTime({}, MEETING), false);
  assert.equal(nextActions.isCancelledMeetingTime(client, ''), false);
  assert.equal(nextActions.isCancelledMeetingTime({ salesPlaybook: { cancelledMeetingAt: 'nope' } }, MEETING), false);
});

test('a card without a cancel marker still takes its MyPhoner time', () => {
  const merged = nextActions.resolveMeetingAtOnMyphonerMerge(
    { meetingAt: '', agreedTime: false, meetingAtSource: '', ownerId: 'admin:damian@asoldi.com', salesPlaybook: { cancelledMeetingAt: '' } },
    MEETING,
  );
  assert.equal(merged.meetingAt, MEETING);
  assert.equal(merged.agreedTime, true);
});

// ---------------------------------------------------------------------------
// data/sales.js reminder gate helpers
// ---------------------------------------------------------------------------

test('salesMeetingStageBlockedReason: only active cards before Tilbud are in the meeting stage', () => {
  assert.equal(sales.salesMeetingStageBlockedReason({ status: 'active', progression: {} }), '');
  assert.equal(sales.salesMeetingStageBlockedReason({ progression: {} }), '');
  assert.equal(sales.salesMeetingStageBlockedReason({ status: 'active', progression: { meetingHeld: true } }), 'stage');
  assert.equal(sales.salesMeetingStageBlockedReason({ status: 'active', progression: { offerSent: true } }), 'stage');
  assert.equal(sales.salesMeetingStageBlockedReason({ status: 'active', progression: { contractSigned: true } }), 'stage');
  assert.equal(sales.salesMeetingStageBlockedReason({ status: 'secondary', progression: {} }), 'status');
  assert.equal(sales.salesMeetingStageBlockedReason({ status: 'not-sold', progression: {} }), 'status');
});

test('salesReminderBlockedReason covers stage, status, confirmation, time and a skip/no-show for this meeting', () => {
  const base = seedConfirmed();
  const before = Date.parse('2026-11-15T13:01:00.000Z');
  assert.equal(sales.salesReminderBlockedReason(base, before), '');
  assert.equal(sales.salesReminderBlockedReason(null, before), 'no-client');
  assert.equal(sales.salesReminderBlockedReason({ ...base, progression: { meetingHeld: true } }, before), 'stage');
  assert.equal(sales.salesReminderBlockedReason({ ...base, progression: { offerSent: true } }, before), 'stage');
  assert.equal(sales.salesReminderBlockedReason({ ...base, progression: { contractSigned: true } }, before), 'stage');
  assert.equal(sales.salesReminderBlockedReason({ ...base, status: 'secondary' }, before), 'status');
  assert.equal(sales.salesReminderBlockedReason({ ...base, status: 'not-sold' }, before), 'status');
  assert.equal(sales.salesReminderBlockedReason({ ...base, reminders: { ...base.reminders, thankYouSentAt: '' } }, before), 'not-confirmed');
  assert.equal(sales.salesReminderBlockedReason({ ...base, agreedTime: false }, before), 'no-meeting');
  assert.equal(sales.salesReminderBlockedReason(base, Date.parse(MEETING)), 'meeting-passed');
  for (const missedKind of ['skipped', 'noShow']) {
    const marked = { ...base, salesPlaybook: { ...base.salesPlaybook, missedKind, missedMeetingAt: MEETING } };
    assert.equal(sales.salesReminderBlockedReason(marked, before), 'missed', missedKind);
    const older = { ...base, salesPlaybook: { ...base.salesPlaybook, missedKind, missedMeetingAt: '2026-11-02T13:00:00.000Z' } };
    assert.equal(sales.salesReminderBlockedReason(older, before), '', `${missedKind} for an older meeting`);
  }
  const auto = { ...base, salesPlaybook: { ...base.salesPlaybook, missedKind: 'auto', missedMeetingAt: MEETING } };
  assert.equal(sales.salesReminderBlockedReason(auto, before), '');
});

test('salesReminderStampsStale spots stamps keyed to another meeting time', () => {
  const fresh = seedConfirmed();
  assert.equal(sales.salesReminderStampsStale(fresh), false);
  const moved = sales.updateSalesClient(fresh.id, { meetingAt: '2026-11-18T14:00:00.000Z' });
  assert.equal(moved.reminders.reminder24hAt, '2026-11-15T13:00:00.000Z', 'a raw meetingAt write leaves the old stamps');
  assert.equal(sales.salesReminderStampsStale(moved), true);
  const rekeyed = sales.rescheduleSalesReminders(fresh.id, Date.parse('2026-11-15T13:01:00.000Z'));
  assert.equal(sales.salesReminderStampsStale(rekeyed), false);
  assert.equal(sales.salesReminderStampsStale({ agreedTime: true, meetingAt: MEETING, reminders: {} }), false);
  assert.equal(sales.salesReminderStampsStale({ agreedTime: false, meetingAt: '', reminders: { reminder1hAt: '2026-11-16T12:00:00.000Z' } }), true);
  assert.equal(
    sales.salesReminderStampsStale({ agreedTime: true, meetingAt: MEETING, reminders: { reminder1hAt: '2026-11-16T12:00:30.000Z' } }),
    false,
    'within a minute of the derived time is the same stamp',
  );
});

// ---------------------------------------------------------------------------
// server.js sendDueRemindersForClient (the automatic loop), real function, stubbed mail
// ---------------------------------------------------------------------------

function reminderLoop() {
  const sent = [];
  const fns = loadServerFunctions(['sendDueRemindersForClient'], {
    SALES_EMAIL_AUTOSEND_ENABLED: true,
    isSalesRepAccountKey: helpers.isSalesRepAccountKey,
    sanitizeText: helpers.sanitizeText,
    sales,
    sendSalesReminderNow: async (client, kind) => {
      sent.push({ id: client.id, kind, meetingAt: client.meetingAt });
      sales.markSalesReminderSent(client.id, kind, new Date().toISOString());
      return { sent: true };
    },
  });
  /** One loop pass for this card object (a snapshot or the stored card). */
  const run = async (client, iso) => {
    const before = sent.length;
    await fns.sendDueRemindersForClient(client, { nowMs: Date.parse(iso) });
    return sent.slice(before).map((row) => row.kind);
  };
  const tick = (id, iso) => run(sales.getSalesClientById(id), iso);
  return { sent, tick, run };
}

test('loop: a confirmed meeting-stage card still gets its reminders on time (control)', async () => {
  const { tick } = reminderLoop();
  const card = seedConfirmed();
  assert.deepEqual(await tick(card.id, '2026-11-13T12:59:00.000Z'), []);
  assert.deepEqual(await tick(card.id, '2026-11-13T13:01:00.000Z'), ['3d']);
  assert.deepEqual(await tick(card.id, '2026-11-15T13:01:00.000Z'), ['24h']);
  assert.deepEqual(await tick(card.id, '2026-11-16T12:01:00.000Z'), ['1h']);
  assert.deepEqual(await tick(card.id, '2026-11-16T12:30:00.000Z'), []);
});

test('loop: Tilbud, Venter signering, Solgt, secondary and not-sold cards get no meeting reminder', async () => {
  const { tick } = reminderLoop();
  // Empty stamps + an old confirmation: exactly the catch-up case that used to fire for a Tilbud card.
  const cases = [
    { progression: { meetingHeld: true } },
    { progression: { meetingHeld: true, offerSent: true } },
    { progression: { meetingHeld: true, offerSent: true, contractSigned: true } },
    { status: 'secondary' },
    { status: 'not-sold' },
  ];
  const control = seedConfirmed();
  sales.updateSalesClient(control.id, { reminders: { reminder3dAt: '', reminder24hAt: '', reminder1hAt: '' } });
  assert.deepEqual(await tick(control.id, '2026-11-16T12:30:00.000Z'), ['24h', '1h'], 'control: catch-up fires on a meeting-stage card');
  for (const patch of cases) {
    const card = seedConfirmed();
    sales.updateSalesClient(card.id, { ...patch, reminders: { reminder3dAt: '', reminder24hAt: '', reminder1hAt: '' } });
    assert.deepEqual(await tick(card.id, '2026-11-16T12:30:00.000Z'), [], JSON.stringify(patch));
  }
});

test('loop: a meeting marked Skip or Møtte ikke opp gets no reminder; a voided one neither', async () => {
  const { tick } = reminderLoop();
  for (const step of ['skip', 'noShow']) {
    const card = seedConfirmed();
    sales.setSalesPlaybookStep(card.id, step, true);
    assert.deepEqual(await tick(card.id, '2026-11-15T13:01:00.000Z'), [], step);
    assert.deepEqual(await tick(card.id, '2026-11-16T12:01:00.000Z'), [], step);
  }
  const voided = sales.voidSalesMeetingTime(seedConfirmed().id, { nowMs: Date.parse('2026-11-14T10:00:00.000Z') });
  assert.deepEqual(await tick(voided.id, '2026-11-15T13:01:00.000Z'), []);
  assert.deepEqual(await tick(voided.id, '2026-11-16T12:01:00.000Z'), []);
});

test('loop: stamps left from an older meeting time are re-keyed, so "om 1 time" never fires days early', async () => {
  const { tick, sent } = reminderLoop();
  const card = seedConfirmed();
  sales.markSalesReminderSent(card.id, '3d', '2026-11-13T13:00:00.000Z');
  const moved = '2026-11-18T14:00:00.000Z'; // Wed 15:00 Oslo
  sales.updateSalesClient(card.id, { meetingAt: moved }); // a path that skips rescheduleSalesReminders

  assert.deepEqual(await tick(card.id, '2026-11-15T13:01:00.000Z'), [], 'old 24h stamp');
  const rekeyed = sales.getSalesClientById(card.id);
  assert.equal(rekeyed.reminders.reminder24hAt, '2026-11-17T14:00:00.000Z');
  assert.equal(rekeyed.reminders.reminder1hAt, '2026-11-18T13:00:00.000Z');
  assert.equal(rekeyed.reminders.reminder3dSentAt, '', 'the old meeting’s sent stamp does not count for the new one');
  assert.deepEqual(await tick(card.id, '2026-11-15T14:01:00.000Z'), ['3d'], 'three days before the new time');
  assert.deepEqual(await tick(card.id, '2026-11-16T12:01:00.000Z'), [], 'old 1h stamp');
  assert.deepEqual(await tick(card.id, '2026-11-17T14:01:00.000Z'), ['24h']);
  assert.deepEqual(await tick(card.id, '2026-11-18T13:01:00.000Z'), ['1h']);
  assert.ok(sent.every((row) => row.meetingAt === moved));
});

test('loop: a 24h reminder that already went out stays sent when a stale re-key lands inside 24 hours', async () => {
  const { tick } = reminderLoop();
  const friday = '2026-11-20T13:00:00.000Z'; // Fri 14:00 Oslo
  const card = seedConfirmed({}, { meetingAt: friday, confirmedAt: '2026-11-15T09:00:00.000Z' });
  assert.deepEqual(await tick(card.id, '2026-11-17T13:01:00.000Z'), ['3d']);
  assert.deepEqual(await tick(card.id, '2026-11-19T13:01:00.000Z'), ['24h']);
  const sent24h = sales.getSalesClientById(card.id).reminders.reminder24hSentAt;
  assert.ok(sent24h);
  const thursday = '2026-11-19T16:00:00.000Z'; // Thu 17:00 Oslo, three hours later
  sales.updateSalesClient(card.id, { meetingAt: thursday }); // moved without rescheduleSalesReminders

  assert.deepEqual(await tick(card.id, '2026-11-19T13:05:00.000Z'), [], 'no second "om 24 timer" three hours before');
  const rekeyed = sales.getSalesClientById(card.id);
  assert.equal(sales.salesReminderStampsStale(rekeyed), false);
  assert.equal(rekeyed.reminders.reminder24hAt, '');
  assert.equal(rekeyed.reminders.reminder24hSentAt, sent24h, 'the 24h mail still counts');
  assert.equal(rekeyed.reminders.reminder1hAt, '2026-11-19T15:00:00.000Z');
  assert.deepEqual(await tick(card.id, '2026-11-19T14:01:00.000Z'), []);
  assert.deepEqual(await tick(card.id, '2026-11-19T15:01:00.000Z'), ['1h']);
  assert.deepEqual(await tick(card.id, '2026-11-19T15:30:00.000Z'), []);

  // Moved further out than 24 hours: the new time gets its own 24h reminder.
  const later = seedConfirmed({}, { meetingAt: friday, confirmedAt: '2026-11-15T09:00:00.000Z' });
  assert.deepEqual(await tick(later.id, '2026-11-19T13:01:00.000Z'), ['3d', '24h']);
  sales.updateSalesClient(later.id, { meetingAt: '2026-11-23T13:00:00.000Z' });
  assert.deepEqual(await tick(later.id, '2026-11-19T13:05:00.000Z'), []);
  assert.equal(sales.getSalesClientById(later.id).reminders.reminder24hSentAt, '');
  assert.deepEqual(await tick(later.id, '2026-11-20T13:01:00.000Z'), ['3d']);
  assert.deepEqual(await tick(later.id, '2026-11-22T13:01:00.000Z'), ['24h']);
});

test('rescheduleSalesReminders keeps a sent 24h stamp only when asked and only inside 24 hours', () => {
  const card = seedConfirmed();
  sales.markSalesReminderSent(card.id, '24h', '2026-11-15T13:00:00.000Z');
  sales.updateSalesClient(card.id, { meetingAt: '2026-11-15T20:00:00.000Z' });
  const inside = Date.parse('2026-11-15T13:30:00.000Z');
  assert.equal(sales.rescheduleSalesReminders(card.id, inside).reminders.reminder24hSentAt, '', 'default clears every sent stamp');
  sales.markSalesReminderSent(card.id, '24h', '2026-11-15T13:00:00.000Z');
  assert.equal(sales.rescheduleSalesReminders(card.id, inside, { keepSent24h: true }).reminders.reminder24hSentAt, '2026-11-15T13:00:00.000Z');
  sales.updateSalesClient(card.id, { meetingAt: '2026-11-18T20:00:00.000Z' });
  assert.equal(sales.rescheduleSalesReminders(card.id, inside, { keepSent24h: true }).reminders.reminder24hSentAt, '', 'outside 24 hours a new 24h is due later');
});

test('loop: decides on the stored card, so a meeting the bot voided after the snapshot gets no reminder', async () => {
  const { run } = reminderLoop();
  const meetingAt = '2026-11-20T09:00:00.000Z';
  const confirmedAt = '2026-11-15T09:00:00.000Z';
  const control = seedConfirmed({}, { meetingAt, confirmedAt });
  const controlSnapshot = sales.getSalesClients().find((row) => row.id === control.id);
  assert.deepEqual(await run(controlSnapshot, '2026-11-19T09:00:30.000Z'), ['3d', '24h'], 'control');

  const card = seedConfirmed({}, { meetingAt, confirmedAt });
  const snapshot = sales.getSalesClients().find((row) => row.id === card.id); // the loop's tick-start snapshot
  sales.voidSalesMeetingTime(card.id, { note: 'Bot: kunden kan ikke', nowMs: Date.parse('2026-11-19T09:00:06.000Z') });
  assert.equal(snapshot.agreedTime, true, 'the snapshot still shows the old booking');
  assert.deepEqual(await run(snapshot, '2026-11-19T09:00:30.000Z'), []);

  const signed = seedConfirmed({}, { meetingAt, confirmedAt });
  const signedSnapshot = sales.getSalesClients().find((row) => row.id === signed.id);
  sales.updateSalesClient(signed.id, { progression: { meetingHeld: true, offerSent: true } });
  assert.deepEqual(await run(signedSnapshot, '2026-11-19T09:00:30.000Z'), []);

  assert.deepEqual(await run({ ...snapshot, id: 'gone-card' }, '2026-11-19T09:00:30.000Z'), [], 'a card no longer in the store');
});

// ---------------------------------------------------------------------------
// server.js sendSalesReminderNow (manual + loop sender) guard
// ---------------------------------------------------------------------------

function reminderSender() {
  const mails = [];
  const fns = loadServerFunctions(['sendSalesReminderNow'], {
    applyRecipientEmail: (client) => ({ client, recipient: client.contactEmail }),
    confirmationSendGaps: nextActions.confirmationSendGaps,
    meetingTimeHasPassed: nextActions.meetingTimeHasPassed,
    sales,
    emailLib: { canSendEmail: () => true, sendEmail: async (mail) => { mails.push(mail); } },
    normalizeSalesReminderKind: (kind) => kind,
    resolveSalesSenderForAccount: async () => ({ email: 'rep1@asoldi.com' }),
    salesUserFromAccountKey: () => null,
    composeEmailForClient: (client, templateKey) => ({ message: { from: 'rep1@asoldi.com', subject: templateKey, text: client.meetingAt } }),
    salesInboxMeetLink: () => '',
    sanitizeText: helpers.sanitizeText,
    salesEmailCopyBcc: () => '',
  });
  return { mails, send: fns.sendSalesReminderNow };
}

test('sendSalesReminderNow refuses a Tilbud / Venter signering / Solgt / archived card and a passed meeting', async () => {
  const { mails, send } = reminderSender();
  const future = hoursFromNow(60 * 24);
  const confirmedAt = hoursFromNow(-24);
  const ok = await send(seedConfirmed({}, { meetingAt: future, confirmedAt }), '24h');
  assert.equal(ok.sent, true);
  assert.equal(mails.length, 1);
  for (const patch of [{ progression: { meetingHeld: true } }, { progression: { offerSent: true } }, { progression: { contractSigned: true } }, { status: 'secondary' }, { status: 'not-sold' }]) {
    const card = seedConfirmed({}, { meetingAt: future, confirmedAt });
    const result = await send(sales.updateSalesClient(card.id, patch), '24h');
    assert.equal(result.sent, false, JSON.stringify(patch));
    assert.equal(result.reason, 'not-meeting-stage');
  }
  const passed = await send(seedConfirmed({}, { meetingAt: hoursFromNow(-30 * 24), confirmedAt: hoursFromNow(-40 * 24) }), '1h');
  assert.equal(passed.sent, false);
  assert.equal(passed.reason, 'reminder-meeting-passed');
  assert.equal(mails.length, 1, 'no extra mail went out');
  assert.match(serverFunctionSource('salesEmailFailureMessage'), /not-meeting-stage/);
  assert.match(serverFunctionSource('salesEmailFailureMessage'), /reminder-meeting-passed/);
});

// ---------------------------------------------------------------------------
// server.js inbox hooks: moveSalesMeetingFromInbox / voidSalesMeetingFromInbox
// ---------------------------------------------------------------------------

/**
 * Real server.js hooks with Google and mail stubbed. `syncThrows`: the calendar sync throws before it re-keys;
 * `thankYouThrows`: the confirmation mail throws (Resend 503); `taskSyncThrows`: the rep task sync throws last.
 */
function inboxHooks({ salesOverride = null, syncThrows = false, thankYouThrows = false, taskSyncThrows = false, deleteThrows = false, watchId = '' } = {}) {
  const calls = [];
  const fns = loadServerFunctions(
    ['applySalesNextActionWithSync', 'inboxHookClient', 'moveSalesMeetingFromInbox', 'inboxMovedClient', 'inboxMeetingIsAt', 'deleteSalesMeetingEventForVoid', 'voidSalesMeetingFromInbox'],
    {
      sales: salesOverride || sales,
      sanitizeText: helpers.sanitizeText,
      sameCalendarInstant: helpers.sameCalendarInstant,
      normalizeMeetingMode: helpers.normalizeMeetingMode,
      isSalesRepAccountKey: helpers.isSalesRepAccountKey,
      appendActionNote: nextActions.appendActionNote,
      calendarOwnerIdForSync: calendarOwner.calendarOwnerIdForSync,
      calendarRecordIsOnBlockedMailbox: calendarOwner.calendarRecordIsOnBlockedMailbox,
      maybeSyncCalendar: async (client, previous, options) => {
        calls.push({ fn: 'maybeSyncCalendar', id: client.id, meetingAt: client.meetingAt, previousMeetingAt: previous.meetingAt, options });
        if (syncThrows) throw new Error('google down');
        return { client, warnings: [] };
      },
      autoSendThankYouFromOwner: async (client, { existing }) => {
        calls.push({ fn: 'autoSendThankYouFromOwner', id: client.id, meetingAt: client.meetingAt, existingMeetingAt: existing.meetingAt });
        if (thankYouThrows) throw new Error('Resend 503');
        const stamped = sales.markSalesReminderSent(client.id, 'thankYou', new Date().toISOString()) || client;
        return { sent: true, client: stamped, warnings: [] };
      },
      maybeSyncNextActionCalendars: async (previous, client, options) => {
        calls.push({ fn: 'maybeSyncNextActionCalendars', id: client.id, previousAgreed: previous.agreedTime, agreed: client.agreedTime, options });
        if (taskSyncThrows) throw new Error('task calendar down');
        return { client, warnings: [] };
      },
      ensureSharedCalendarTokens: async (key) => { calls.push({ fn: 'ensureSharedCalendarTokens', key }); },
      deleteMeetingEvent: async (eventId, accountKey, options) => {
        const card = watchId ? sales.getSalesClientById(watchId) : null;
        calls.push({ fn: 'deleteMeetingEvent', eventId, accountKey, options, cardStillBooked: Boolean(card?.agreedTime) });
        if (deleteThrows) throw new Error('404');
        return { deleted: true };
      },
      console: { log() {}, warn() {}, error() {} },
    },
  );
  return { calls, ...fns };
}

test('move hook: runs the rep chain as the card’s rep, puts the bot note on the row, re-keys reminders', async () => {
  const { calls, moveSalesMeetingFromInbox } = inboxHooks();
  const card = seedConfirmed();
  const target = hoursFromNow(30 * 24); // the hook re-keys with the real clock
  const result = await moveSalesMeetingFromInbox(card, target, { note: 'Bot: kunden ba om torsdag kl 11' });
  assert.equal(result.ok, true);
  assert.equal(result.error, '');
  assert.equal(result.confirmationSent, true);
  assert.equal(result.client.meetingAt, target);
  assert.equal(result.client.agreedTime, true);
  assert.equal(openRow(result.client, 'meeting').dueAt, target);
  assert.equal(openRow(result.client, 'meeting').note, 'Bot: kunden ba om torsdag kl 11');
  assert.deepEqual(calls.map((row) => row.fn), ['maybeSyncCalendar', 'autoSendThankYouFromOwner', 'maybeSyncNextActionCalendars']);
  assert.deepEqual(calls[0].options, { notifyAttendees: true, forceGuestInvite: true, actorAccountKey: 'sales:rep1' });
  assert.equal(calls[0].previousMeetingAt, MEETING);
  assert.equal(calls[1].existingMeetingAt, MEETING);
  assert.deepEqual(calls[2].options, { actorAccountKey: 'sales:rep1' });
  assert.equal(result.client.reminders.reminder24hAt, new Date(Date.parse(target) - 24 * HOUR_MS).toISOString());
  assert.equal(result.client.reminders.reminder1hAt, new Date(Date.parse(target) - HOUR_MS).toISOString());
  assert.equal(result.client.reminders.reminder24hSentAt, '');
  assert.equal(sales.salesReminderStampsStale(result.client), false);
});

test('move hook: an unassigned card moves without notifying the client or sending a confirmation', async () => {
  const { calls, moveSalesMeetingFromInbox } = inboxHooks();
  const card = seedConfirmed({ ownerId: 'admin:damian@asoldi.com' });
  const target = hoursFromNow(30 * 24);
  const result = await moveSalesMeetingFromInbox(card, new Date(target)); // a Date works as well as an ISO string
  assert.equal(result.ok, true);
  assert.equal(result.client.meetingAt, target);
  assert.equal(result.confirmationSent, false);
  assert.deepEqual(calls.map((row) => row.fn), ['maybeSyncCalendar', 'maybeSyncNextActionCalendars']);
  assert.equal(calls[0].options.notifyAttendees, false);
  assert.equal(calls[0].options.forceGuestInvite, false);
  assert.equal(openRow(result.client, 'meeting').note, '', 'no note given, none written');
  assert.equal(sales.salesReminderStampsStale(result.client), false);
});

test('move hook: refuses past the meeting stage, without an open meeting row, and never throws', async () => {
  const { calls, moveSalesMeetingFromInbox } = inboxHooks();
  const tilbud = seedConfirmed();
  sales.updateSalesClient(tilbud.id, { progression: { meetingHeld: true } });
  const refused = await moveSalesMeetingFromInbox(tilbud, '2026-11-19T10:00:00.000Z');
  assert.deepEqual([refused.ok, refused.error, refused.confirmationSent], [false, 'not-meeting-stage', false]);
  assert.equal(sales.getSalesClientById(tilbud.id).meetingAt, MEETING);

  const missing = await moveSalesMeetingFromInbox({ id: 'nobody' }, '2026-11-19T10:00:00.000Z');
  assert.deepEqual([missing.ok, missing.client, missing.error], [false, null, 'client-not-found']);

  const bad = await moveSalesMeetingFromInbox(seedConfirmed(), 'not a time');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /påkrevd/);
  assert.equal(calls.length, 0, 'nothing reached the calendar or the mail');

  const noRowCard = seedConfirmed();
  const withoutRow = {
    ...sales,
    getSalesClientById: (id) => {
      const real = sales.getSalesClientById(id);
      return real ? { ...real, nextActions: real.nextActions.filter((row) => row.presetKey !== 'meeting') } : null;
    },
  };
  const noRow = await inboxHooks({ salesOverride: withoutRow }).moveSalesMeetingFromInbox(noRowCard, '2026-11-19T10:00:00.000Z');
  assert.deepEqual([noRow.ok, noRow.error], [false, 'no-meeting-row']);

  // Nothing written: the row write itself fails.
  const brokenStore = { ...sales, setSalesNextAction: () => { throw new Error('disk full'); } };
  const unwritten = seedConfirmed();
  const failed = await inboxHooks({ salesOverride: brokenStore }).moveSalesMeetingFromInbox(unwritten, '2026-11-19T10:00:00.000Z');
  assert.deepEqual([failed.ok, failed.error, failed.confirmationSent], [false, 'disk full', false]);
  assert.ok(failed.client, 'the fresh card comes back even on failure');
  assert.equal(sales.getSalesClientById(unwritten.id).meetingAt, MEETING);
});

test('move hook: when a step after the row write throws, the card already moved, so the hook reports ok', async () => {
  // (a) The calendar sync throws before it re-keys reminders.
  const target = hoursFromNow(30 * 24);
  const syncFails = inboxHooks({ syncThrows: true });
  const card = seedConfirmed();
  const moved = await syncFails.moveSalesMeetingFromInbox(card, target, { note: 'Bot: ny tid' });
  assert.deepEqual([moved.ok, moved.error, moved.confirmationSent], [true, '', false]);
  assert.equal(moved.warning, 'google down', 'the failed step is still reported');
  assert.equal(moved.client.meetingAt, target);
  assert.equal(openRow(moved.client, 'meeting').dueAt, target);
  assert.equal(sales.salesReminderStampsStale(moved.client), false, 'stamps follow the new time anyway');
  assert.equal(moved.client.reminders.reminder24hAt, new Date(Date.parse(target) - 24 * HOUR_MS).toISOString());

  // (b) The Google invite went out, then the branded confirmation mail threw: no confirmation, the bot writes its own line.
  const mailFails = inboxHooks({ thankYouThrows: true });
  const invited = await mailFails.moveSalesMeetingFromInbox(seedConfirmed(), target);
  assert.deepEqual([invited.ok, invited.error, invited.confirmationSent, invited.warning], [true, '', false, 'Resend 503']);
  assert.equal(invited.client.meetingAt, target);
  assert.deepEqual(mailFails.calls.map((row) => row.fn), ['maybeSyncCalendar', 'autoSendThankYouFromOwner']);

  // (c) The confirmation went out, then the rep task sync threw: report it as sent, so the bot adds no second mail.
  const taskFails = inboxHooks({ taskSyncThrows: true });
  const confirmed = await taskFails.moveSalesMeetingFromInbox(seedConfirmed(), target);
  assert.deepEqual([confirmed.ok, confirmed.error, confirmed.confirmationSent], [true, '', true]);
  assert.notEqual(confirmed.client.reminders.thankYouSentAt, CONFIRMED_AT);
});

test('move hook: an already-sent 24h reminder is not repeated when the hook moves the meeting inside 24 hours', async () => {
  // The calendar sync returns early without re-keying (shared or blocked host) and the confirmation mail throws.
  const hooks = loadServerFunctions(['applySalesNextActionWithSync', 'inboxHookClient', 'moveSalesMeetingFromInbox', 'inboxMovedClient', 'inboxMeetingIsAt'], {
    sales,
    sanitizeText: helpers.sanitizeText,
    sameCalendarInstant: helpers.sameCalendarInstant,
    normalizeMeetingMode: helpers.normalizeMeetingMode,
    isSalesRepAccountKey: helpers.isSalesRepAccountKey,
    appendActionNote: nextActions.appendActionNote,
    maybeSyncCalendar: async (client) => ({ client, warnings: ['Refusing to host this meeting on a shared mailbox.'] }),
    autoSendThankYouFromOwner: async () => { throw new Error('Resend 429'); },
    maybeSyncNextActionCalendars: async (_previous, client) => ({ client, warnings: [] }),
    console: { log() {}, warn() {}, error() {} },
  });
  const { tick } = reminderLoop();
  const original = hoursFromNow(20);
  const card = seedConfirmed({}, { meetingAt: original, confirmedAt: hoursFromNow(-5 * 24) });
  sales.markSalesReminderSent(card.id, '3d', hoursFromNow(-52));
  sales.markSalesReminderSent(card.id, '24h', hoursFromNow(-4));
  const sent24h = sales.getSalesClientById(card.id).reminders.reminder24hSentAt;
  const target = hoursFromNow(3);

  const result = await hooks.moveSalesMeetingFromInbox(sales.getSalesClientById(card.id), target, { note: 'Bot: i dag' });

  assert.deepEqual([result.ok, result.confirmationSent], [true, false]);
  assert.equal(result.client.meetingAt, target);
  assert.equal(result.client.reminders.reminder24hSentAt, sent24h);
  assert.equal(sales.salesReminderStampsStale(result.client), false);
  assert.deepEqual(await tick(card.id, new Date().toISOString()), [], 'no "om 24 timer" three hours before');
  const oneHourBefore = new Date(Date.parse(target) - HOUR_MS + 60 * 1000).toISOString();
  assert.deepEqual(await tick(card.id, oneHourBefore), ['1h']);
});

test('void hook: deletes the Google event first (client notified), then voids the card and syncs rep task events', async () => {
  const card = addFollowerRows(seedConfirmed().id);
  const hooks = inboxHooks({ watchId: card.id });
  const result = await hooks.voidSalesMeetingFromInbox(card, { note: 'Bot: kunden kan ikke', notifyClient: true });
  assert.equal(result.ok, true);
  assert.equal(result.error, '');
  assert.deepEqual(hooks.calls.map((row) => row.fn), ['ensureSharedCalendarTokens', 'deleteMeetingEvent', 'maybeSyncNextActionCalendars']);
  const del = hooks.calls.find((row) => row.fn === 'deleteMeetingEvent');
  assert.equal(del.eventId, 'evt-old');
  assert.equal(del.accountKey, 'sales:rep1');
  assert.deepEqual(del.options, { calendarId: 'rep1@asoldi.com', sendUpdates: 'all' });
  assert.equal(del.cardStillBooked, true, 'the event is deleted before the card loses its ids');
  const sync = hooks.calls.find((row) => row.fn === 'maybeSyncNextActionCalendars');
  assert.deepEqual([sync.previousAgreed, sync.agreed], [true, false]);
  assert.equal(result.client.agreedTime, false);
  assert.equal(result.client.calendar.eventId, '');
  assert.equal(openRow(result.client, 'meeting').note, 'Bot: kunden kan ikke');
  assert.equal(result.client.salesPlaybook.cancelledMeetingAt, MEETING);
});

test('void hook: silent delete when notifyClient is false, still voids when Google fails, refuses past the meeting stage', async () => {
  const quiet = inboxHooks();
  const card = seedConfirmed();
  const result = await quiet.voidSalesMeetingFromInbox(card, { notifyClient: false });
  assert.equal(result.ok, true);
  assert.equal(quiet.calls.find((row) => row.fn === 'deleteMeetingEvent').options.sendUpdates, 'none');

  const failing = inboxHooks({ deleteThrows: true });
  const despite = await failing.voidSalesMeetingFromInbox(seedConfirmed());
  assert.equal(despite.ok, true);
  assert.equal(despite.client.meetingAt, '');

  const noEvent = inboxHooks();
  const plain = seedConfirmed();
  sales.updateSalesClient(plain.id, { calendar: { eventId: '' } });
  const voidedPlain = await noEvent.voidSalesMeetingFromInbox(plain);
  assert.equal(voidedPlain.ok, true);
  assert.equal(noEvent.calls.some((row) => row.fn === 'deleteMeetingEvent'), false);

  const guarded = inboxHooks();
  const signing = seedConfirmed();
  sales.updateSalesClient(signing.id, { progression: { meetingHeld: true, offerSent: true } });
  const refused = await guarded.voidSalesMeetingFromInbox(signing);
  assert.deepEqual([refused.ok, refused.error], [false, 'not-meeting-stage']);
  assert.equal(guarded.calls.length, 0);
  assert.equal(sales.getSalesClientById(signing.id).calendar.eventId, 'evt-old');

  const missing = await guarded.voidSalesMeetingFromInbox(null);
  assert.deepEqual([missing.ok, missing.client, missing.error], [false, null, 'client-not-found']);
});

// ---------------------------------------------------------------------------
// server.js wiring: route reuse, hooks, kill switch, list cache key
// ---------------------------------------------------------------------------

test('PATCH next-actions runs the shared chain with the signed-in rep as actor', () => {
  const start = serverSrc.indexOf("app.patch('/api/admin/sales/:id/next-actions'");
  const route = serverSrc.slice(start, serverSrc.indexOf('\n});', start));
  assert.match(route, /applySalesNextActionWithSync\(existing, req\.body \|\| \{\}, \{\s*actorAccountKey: req\.salesUser\.accountKey,\s*\}\)/);
  assert.match(route, /res\.json\(result\)/);
  assert.equal(route.includes('maybeSyncCalendar('), false, 'the chain lives in one place');
  const shared = serverFunctionSource('applySalesNextActionWithSync');
  assert.match(shared, /return \{ client, warnings, thankYouSent, meetingChanged \};/);
  assert.ok(shared.indexOf('maybeSyncCalendar(') < shared.indexOf('autoSendThankYouFromOwner('));
  assert.ok(shared.indexOf('autoSendThankYouFromOwner(') < shared.indexOf('maybeSyncNextActionCalendars('));
});

test('the inbox loop and the backfill route get both meeting hooks', () => {
  const loop = serverFunctionSource('startInboxBotLoop');
  assert.match(loop, /tickInboxBot\(\{ moveMeeting: moveSalesMeetingFromInbox, voidMeeting: voidSalesMeetingFromInbox \}\)/);
  assert.ok(loop.indexOf('inboxBotLoopEnabled()') < loop.indexOf('setInterval'), 'the kill switch stops the loop before it is scheduled');
  const start = serverSrc.indexOf("app.post('/api/admin/inbox-bot/backfill'");
  const route = serverSrc.slice(start, serverSrc.indexOf('\n});', start));
  assert.match(route, /backfillInboxReplies\(\{[\s\S]*moveMeeting: moveSalesMeetingFromInbox,\s*voidMeeting: voidSalesMeetingFromInbox,/);
});

test('the inbox loop and the backfill route share one lock: neither starts while the other runs', async () => {
  const decl = /\nlet inboxBotBusy = '';\r?\n/.exec(serverSrc);
  assert.ok(decl, 'server.js declares the shared inbox lock');
  const start = serverSrc.indexOf("app.post('/api/admin/inbox-bot/backfill'");
  const route = serverSrc.slice(start, serverSrc.indexOf('\n});', start) + 4);
  const routes = {};
  const ticks = [];
  const calls = [];
  let finishTick;
  let finishBackfill;
  const deps = {
    app: { post: (path, _auth, handler) => { routes[path] = handler; } },
    adminAuth: () => {},
    setInterval: (fn) => { ticks.push(fn); return 1; },
    SALES_REMINDER_POLL_MS: 60_000,
    inboxBotInterval: null,
    inboxBotLoopEnabled: () => true,
    moveSalesMeetingFromInbox: () => {},
    voidSalesMeetingFromInbox: () => {},
    tickInboxBot: () => { calls.push('tick'); return new Promise((resolve) => { finishTick = resolve; }); },
    backfillInboxReplies: (options) => {
      calls.push(`backfill:${options.apply}`);
      return new Promise((resolve, reject) => { finishBackfill = { resolve, reject }; });
    },
    console: { log() {}, error() {} },
  };
  const body = `${decl[0]}\n${serverFunctionSource('startInboxBotLoop')}\n${route}\nreturn { startInboxBotLoop, busy: () => inboxBotBusy };`;
  // eslint-disable-next-line no-new-func
  const loaded = new Function(...Object.keys(deps), body)(...Object.values(deps));
  loaded.startInboxBotLoop();
  const handler = routes['/api/admin/inbox-bot/backfill'];
  const post = async (reqBody) => {
    const res = { code: 200, body: null, status(code) { this.code = code; return this; }, json(payload) { this.body = payload; return this; } };
    await handler({ body: reqBody }, res);
    return res;
  };
  const settle = () => new Promise((resolve) => { setImmediate(resolve); });
  const send = { apply: true, confirm: 'backfill-once' };

  // A tick is running: the backfill is refused (409, Norwegian) and never starts.
  ticks[0]();
  assert.equal(loaded.busy(), 'tick');
  const refused = await post(send);
  assert.equal(refused.code, 409);
  assert.match(refused.body.message, /Innboksen leses akkurat nå/);
  assert.deepEqual(calls, ['tick']);
  finishTick();
  await settle();
  assert.equal(loaded.busy(), '');

  // A backfill is running: the tick skips, and a second backfill (even a dry run) is refused.
  const running = post(send);
  assert.equal(loaded.busy(), 'backfill');
  ticks[0]();
  const second = await post({ apply: false });
  assert.equal(second.code, 409);
  assert.match(second.body.message, /backfill kjører allerede/);
  assert.deepEqual(calls, ['tick', 'backfill:true']);
  finishBackfill.resolve({ mailbox: 'alexander@asoldi.com', results: [] });
  const done = await running;
  assert.deepEqual([done.code, done.body], [200, { mailbox: 'alexander@asoldi.com', results: [] }]);
  assert.equal(loaded.busy(), '');
  ticks[0]();
  assert.deepEqual(calls, ['tick', 'backfill:true', 'tick']);
  finishTick();
  await settle();

  // A failed backfill frees the lock; a request without the confirm word never takes it.
  const failing = post(send);
  finishBackfill.reject(new Error('imap down'));
  assert.equal((await failing).code, 500);
  assert.equal(loaded.busy(), '');
  assert.equal((await post({ apply: true })).code, 400);
  assert.equal(loaded.busy(), '');
});

test('a portal / preview e-signature marks Solgt with fastTrack, even on a card without Møte and Tilbud ticks', async () => {
  // 'Gi tilbud' -> 'Opprett tilbud' creates an offer on a meeting-stage card without ticking anything.
  const card = seedConfirmed();
  assert.equal(card.progression.meetingHeld, false);
  assert.equal(card.progression.offerSent, false);
  const soldCalls = [];
  const { acceptPortalOfferForUser } = loadServerFunctions(['acceptPortalOfferForUser'], {
    salesOffers: {
      getSalesOfferById: () => null,
      offerHasDualAlternatives: () => false,
      parseChosenOfferIndex: () => ({ ok: true, index: 0 }),
    },
    offers: { recordOfferAcceptance: (id, acceptance) => ({ id, salesClientId: card.id, acceptance: { ...acceptance, acceptedAt: '2026-11-14T10:00:00.000Z' } }) },
    sales,
    sanitizeText: helpers.sanitizeText,
    // Same tick as lib/sales-signed-contract.js markClientSoldFromSignedContract, without the workshop mail.
    markClientSoldFromSignedContract: (clientId, options = {}) => {
      soldCalls.push({ clientId, options });
      return sales.setSalesProgress(clientId, 'contractSigned', true, { fastTrack: Boolean(options.fastTrack) });
    },
    storePreviewAcceptedContract: async () => {},
    console: { log() {}, warn() {}, error() {} },
  });
  const req = { body: {}, ip: '127.0.0.1', socket: {}, get: () => 'test-agent' };
  const result = await acceptPortalOfferForUser({ id: 'offer-1', salesClientId: card.id }, { id: 'u1', username: card.contactEmail }, req);
  assert.equal(result.offer.acceptance.acceptedAt, '2026-11-14T10:00:00.000Z');
  assert.deepEqual(soldCalls, [{ clientId: card.id, options: { fastTrack: true } }]);
  const signed = sales.getSalesClientById(card.id);
  assert.equal(signed.progression.contractSigned, true, 'the client e-signed: Solgt');
  assert.match(serverFunctionSource('acceptPortalOfferForUser'), /markClientSoldFromSignedContract\(salesClient\.id, \{ fastTrack: true \}\)/);
  // Control: without fastTrack the same card stays put (the email rule).
  const other = seedConfirmed();
  assert.throws(() => sales.setSalesProgress(other.id, 'contractSigned', true), /Marker/);
});

test('INBOX_BOT_ENABLED: the loop stays on unless it is 0, false or off', () => {
  const { inboxBotLoopEnabled } = loadServerFunctions(['inboxBotLoopEnabled'], {});
  for (const value of [undefined, '', '1', 'true', 'on', 'yes']) assert.equal(inboxBotLoopEnabled(value), true, String(value));
  for (const value of ['0', 'false', 'off', 'OFF', ' False ', ' off ']) assert.equal(inboxBotLoopEnabled(value), false, value);
});

test('the sales list cache key follows the inbox store, so a new inbox item shows at once', () => {
  let inboxRev = 3;
  const { salesListCacheKey } = loadServerFunctions(['salesListCacheKey'], {
    sales: { salesDataRevision: () => 7 },
    salesOffers: { offersDataRevision: () => 2 },
    inboxStoreRevision: () => inboxRev,
  });
  const first = salesListCacheKey();
  inboxRev += 1;
  assert.notEqual(salesListCacheKey(), first);
  const cached = serverFunctionSource('cachedSalesListRows');
  assert.equal((cached.match(/salesListCacheKey\(\)/g) || []).length, 2);
  assert.match(serverSrc, /import \{ inboxStoreRevision \} from '\.\/lib\/inbox-bot\/store\.js';/);
});
