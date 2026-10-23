// Every recording lands on the right client and the right booked slot, and nothing a person did is
// silently undone (the slot rules themselves: scripts/fireflies-slots.test.mjs): people's links win (M7),
// no evidence is no unlink (M8), ownership only from booked rooms (M9), the offer lock never names a
// placeholder (M10), the card is the one record of who holds a recording (M11/F13), moves clean up after
// themselves (M12), and the card, the offer and the activity log count one copy per meeting (M6/M15/M16).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-ff-match-'));
process.env.APP_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const slots = await import('../lib/fireflies-slots.js');
const matcher = await import('../lib/fireflies-client-match.js');
const offerMeetings = await import('../lib/offer-meetings.js');
const activity = await import('../lib/sales-activity-log.js');
const ff = await import('../lib/fireflies-webhook.js');
const meetings = await import('../lib/workshop-meetings.js');
const sales = await import('../data/sales.js');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const iso = (ms) => new Date(ms).toISOString();
const SALES_ROOM = 'https://meet.google.com/sal-room-aaa';
const WORKSHOP_ROOM = 'https://meet.google.com/wrk-room-bbb';
const ITERATION_ROOM = 'https://meet.google.com/itr-room-ccc';
const ACTION_ROOM = 'https://meet.google.com/act-room-ddd';
const OTHER_ROOM = 'https://meet.google.com/oth-room-eee';
const SALES_AT = Date.parse('2026-10-20T10:00:00.000Z');
const WORKSHOP_AT = Date.parse('2026-10-22T10:00:00.000Z');

/** One client with a sales meeting, a workshop Møte, an iteration Møte and an extra recorded Møte. */
function bookedClient(overrides = {}) {
  return {
    id: 'c-booked',
    businessName: 'Testfirma AS',
    agreedTime: true,
    meetingAt: iso(SALES_AT),
    meetingMode: 'online',
    calendar: { meetLink: SALES_ROOM, confirmedMeetLink: SALES_ROOM },
    workshopAction: { name: 'Workshop', format: 'mote', dueAt: iso(WORKSHOP_AT), meetLink: WORKSHOP_ROOM, status: 'confirmed' },
    workshop: { iterationMeeting: { format: 'mote', dueAt: iso(WORKSHOP_AT + 7 * 24 * HOUR), meetLink: ITERATION_ROOM } },
    nextActions: [{
      id: 'na-plan',
      goalKey: 'offerSent',
      presetKey: 'custom',
      name: 'Planlegg neste møte',
      format: 'mote',
      addToCalendar: true,
      dueAt: iso(SALES_AT + 2 * 24 * HOUR),
      meetLink: ACTION_ROOM,
    }],
    meetings: [],
    ...overrides,
  };
}

function placeholder(kind, startMs, room, extra = {}) {
  const scope = kind === 'sales' ? 'c-booked' : `c-booked:${kind}`;
  return {
    meetingId: `live:${scope}:${startMs}`,
    startedAt: iso(startMs),
    meetLink: room,
    hasTranscript: false,
    linkedBy: 'live-join',
    purpose: kind,
    forSalesMeeting: kind === 'sales',
    slotKey: `${kind}:${startMs}`,
    recording: { state: 'ended' },
    ...extra,
  };
}

function recording(meetingId, room, startMs, extra = {}) {
  return { meetingId, meetLink: room, startedAt: iso(startMs), hasTranscript: true, linkedBy: 'meet-link', ...extra };
}

test('M6/M16: the offer counts one per meeting and seeds only the sales meeting\'s recordings', () => {
  const real = { meetingId: 'ff-real', meetLink: SALES_ROOM, startedAt: iso(SALES_AT), transcript: 'Kari: vi vil ha nettside.\nSelger: flott.', durationMinutes: 50 };
  const fragment = { meetingId: 'ff-frag', meetLink: SALES_ROOM, startedAt: iso(SALES_AT + MIN), transcript: 'Kari: hei', durationMinutes: 2 };
  const fill = offerMeetings.offerAutoFillDecision({ offer: { meetingIds: ['ff-real', 'ff-frag'] }, meetings: [real, fragment] });
  assert.equal(fill.action, 'fill', 'a short fragment next to the real recording does not ask for a pick');
  assert.deepEqual(fill.meetings.map((row) => row.meetingId), ['ff-real']);
  const second = { meetingId: 'ff-second', meetLink: ACTION_ROOM, startedAt: iso(SALES_AT + 2 * 24 * HOUR), summary: 'Oppfølging' };
  assert.equal(offerMeetings.offerAutoFillDecision({ offer: { meetingIds: ['ff-real', 'ff-second'] }, meetings: [real, second] }).action, 'pick');
  const workshopTalk = { meetingId: 'ff-ws', purpose: 'workshop', meetLink: WORKSHOP_ROOM, startedAt: iso(WORKSHOP_AT), transcript: 'Workshop' };
  assert.equal(offerMeetings.offerAutoFillDecision({ offer: {}, meetings: [real, workshopTalk] }).action, 'fill', 'no pick needed: the workshop is not offer material by default');
  const client = {
    meetings: [
      { meetingId: 'ff-real', hasTranscript: true, purpose: 'sales', meetLink: SALES_ROOM, startedAt: iso(SALES_AT), sentenceCount: 500 },
      { meetingId: 'ff-frag', hasTranscript: true, purpose: 'sales', meetLink: SALES_ROOM, startedAt: iso(SALES_AT + MIN), sentenceCount: 3 },
      { meetingId: 'ff-ws', hasTranscript: true, purpose: 'workshop', meetLink: WORKSHOP_ROOM, startedAt: iso(WORKSHOP_AT) },
      { meetingId: 'ff-plan', hasTranscript: true, purpose: '', meetLink: ACTION_ROOM, startedAt: iso(SALES_AT + 2 * 24 * HOUR) },
    ],
  };
  assert.deepEqual(offerMeetings.seedOfferMeetingIds({ status: 'draft' }, client), ['ff-real', 'ff-plan']);
  assert.deepEqual(
    offerMeetings.seedOfferMeetingIds({ status: 'draft', meetingIds: ['ff-ws', 'ff-frag', 'ff-real'] }, client),
    ['ff-real', 'ff-plan'],
    'an automatic selection drops the workshop and the fragment',
  );
  assert.deepEqual(
    offerMeetings.seedOfferMeetingIds({ status: 'draft', meetingSource: 'manual', meetingIds: ['ff-ws'] }, client),
    ['ff-ws'],
    'a rep\'s pick stays',
  );
  assert.equal(offerMeetings.offerLetterNeedsMeetingPick({ meetings: client.meetings.slice(0, 3) }), false);
  assert.equal(offerMeetings.offerLetterNeedsMeetingPick({ meetings: client.meetings }), true);
});

test('M7/M8/M9: the backfill never undoes a person, needs evidence to unlink, and settles a shared room by its slots', () => {
  const owner = bookedClient({ id: 'c-owner', businessName: 'Eier AS', meetings: [] });
  const other = {
    id: 'c-other',
    businessName: 'Annen AS',
    agreedTime: true,
    meetingAt: iso(SALES_AT + 24 * HOUR),
    calendar: { meetLink: OTHER_ROOM },
    meetings: [],
  };
  const stored = [{ meetingId: 'ff-1', meetingLink: SALES_ROOM, startedAt: iso(SALES_AT) }];
  for (const linkedBy of ['admin:superadmin', 'sales:rep-1', 'manual']) {
    const plan = matcher.planFirefliesMeetLinkBackfill({
      clients: [owner, { ...other, meetings: [{ meetingId: 'ff-1', linkedBy }] }],
      meetings: stored,
    });
    assert.deepEqual([plan.moves.length, plan.unlinks.length], [0, 0], `${linkedBy} on another client stays`);
  }
  const pickedPurpose = matcher.planFirefliesMeetLinkBackfill({
    clients: [owner, { ...other, meetings: [{ meetingId: 'ff-1', linkedBy: 'auto', purposePickedAt: iso(SALES_AT) }] }],
    meetings: stored,
  });
  assert.equal(pickedPurpose.unlinks.length, 0, 'a person\'s purpose pick protects the row too');
  const automatic = matcher.planFirefliesMeetLinkBackfill({
    clients: [owner, { ...other, meetings: [{ meetingId: 'ff-1', linkedBy: 'auto' }] }],
    meetings: stored,
  });
  assert.deepEqual(automatic.unlinks.map((row) => row.fromClientId), ['c-other']);
  assert.deepEqual(automatic.moves.map((row) => row.toClientId), ['c-owner']);
  // A pin brings it back to the person's client; an exclusion keeps it off one.
  const pinned = matcher.planFirefliesMeetLinkBackfill({
    clients: [owner, other],
    meetings: [{ ...stored[0], pin: { clientId: 'c-other', linkedBy: 'admin:superadmin' } }],
  });
  assert.deepEqual(pinned.moves.map((row) => [row.toClientId, row.linkedBy]), [['c-other', 'admin:superadmin']]);
  const excluded = matcher.planFirefliesMeetLinkBackfill({
    clients: [{ ...owner, meetings: [{ meetingId: 'ff-1', linkedBy: 'meet-link' }] }, other],
    meetings: [{ ...stored[0], excludedClientIds: ['c-owner'] }],
  });
  assert.deepEqual(excluded.unlinks.map((row) => [row.fromClientId, row.reason]), [['c-owner', 'excluded']]);
  assert.equal(excluded.moves.length, 0);
  // M8: no stored record is no evidence for an automatic link; the old hub's title links still go.
  const missing = matcher.planFirefliesMeetLinkBackfill({
    clients: [{ ...owner, meetings: [{ meetingId: 'gone-1', linkedBy: 'auto' }, { meetingId: 'gone-2', linkedBy: 'meet-link' }, { meetingId: 'gone-3', linkedBy: 'name' }] }],
    meetings: stored,
  });
  assert.deepEqual(missing.unlinks.map((row) => row.meetingId), ['gone-3']);
  // M9: a room two clients hold goes to the one whose booked slot fits; with none, links stay.
  const sharing = { ...other, recordedMeetLinks: [SALES_ROOM], meetings: [{ meetingId: 'ff-1', linkedBy: 'auto' }] };
  const settled = matcher.planFirefliesMeetLinkBackfill({
    clients: [owner, sharing],
    meetings: stored,
    slotOwner: slots.slotOwnerAmongClients,
  });
  assert.deepEqual(settled.moves.map((row) => row.toClientId), ['c-owner'], 'the recording started in the owner\'s booked slot');
  assert.deepEqual(settled.unlinks.map((row) => row.fromClientId), ['c-other']);
  const unsettled = matcher.planFirefliesMeetLinkBackfill({
    clients: [owner, sharing],
    meetings: [{ ...stored[0], startedAt: iso(SALES_AT + 9 * 24 * HOUR) }],
    slotOwner: slots.slotOwnerAmongClients,
  });
  assert.deepEqual([unsettled.moves.length, unsettled.unlinks.length], [0, 0], 'no slot fits: the existing link stays');
});

test('M7/M9: the matcher puts a person\'s link first, honours exclusions, and settles a shared room by its slots', () => {
  const owner = bookedClient({ id: 'c-owner' });
  const other = { id: 'c-other', businessName: 'Annen AS', recordedMeetLinks: [SALES_ROOM], meetings: [] };
  const record = { meetingId: 'ff-1', meetingLink: SALES_ROOM, startedAt: iso(SALES_AT + 3 * MIN) };
  assert.equal(matcher.matchMeetingToClients(record, [owner, other]).best, null, 'two clients hold the room');
  assert.equal(matcher.matchMeetingToClients(record, [owner, other], { slotOwner: slots.slotOwnerAmongClients }).best?.clientId, 'c-owner');
  const held = { ...other, meetings: [{ meetingId: 'ff-1', linkedBy: 'sales:rep-1' }] };
  assert.equal(matcher.matchMeetingToClients(record, [owner, held]).best?.clientId, 'c-other', 'a person\'s link wins');
  assert.equal(matcher.matchMeetingToClients({ ...record, pin: { clientId: 'c-other' } }, [owner, other]).best?.clientId, 'c-other');
  assert.equal(
    matcher.matchMeetingToClients({ ...record, pin: { clientId: 'c-other' } }, [owner, other], { people: false, slotOwner: slots.slotOwnerAmongClients }).best?.clientId,
    'c-owner',
    'people: false asks only whose room it is',
  );
  const lone = bookedClient({ id: 'c-lone' });
  assert.equal(matcher.matchMeetingToClients({ ...record, excludedClientIds: ['c-lone'] }, [lone]).best, null, '"Ikke denne kunden" holds');
  assert.equal(matcher.automaticLinkRefusal('ff-1', 'c-lone', { stored: { excludedClientIds: ['c-lone'] }, clients: [lone] }), 'excluded');
  assert.equal(matcher.automaticLinkRefusal('ff-1', 'c-owner', { stored: { pin: { clientId: 'c-other' } }, clients: [owner, other] }), 'pinned');
  assert.equal(matcher.automaticLinkRefusal('ff-1', 'c-owner', { stored: {}, clients: [owner, held] }), 'person');
  assert.equal(matcher.automaticLinkRefusal('ff-1', 'c-owner', { stored: { pin: { clientId: 'c-gone' } }, clients: [owner] }), '');
  assert.equal(matcher.isProtectedHumanLink('developer:dev-1'), true);
  assert.equal(matcher.isProtectedHumanLink('meet-link'), false);
});

test('M9: a pasted room is copied onto an action only when it is already this client\'s alone; a recording goes on its own slot\'s action', () => {
  const client = bookedClient();
  assert.equal(matcher.meetRoomIsOnlyClients(SALES_ROOM, client, [client]), true);
  assert.equal(matcher.meetRoomIsOnlyClients(OTHER_ROOM, client, [client]), false, 'a room of no booking of this client');
  const rival = { id: 'c-rival', calendar: { meetLink: SALES_ROOM } };
  assert.equal(matcher.meetRoomIsOnlyClients(SALES_ROOM, client, [client, rival]), false, 'a room another client holds');
  const actions = [
    { id: 'na-meeting', presetKey: 'meeting', format: 'mote', dueAt: iso(SALES_AT) },
    { id: 'na-bare', presetKey: 'custom', format: 'mote', dueAt: iso(SALES_AT + 30 * MIN) },
    { ...client.nextActions[0] },
  ];
  const pasted = { meetingId: 'ff-paste', meetLink: OTHER_ROOM, startedAt: iso(SALES_AT + 31 * MIN) };
  const attached = activity.attachFirefliesToMatchingAction(actions, pasted);
  assert.equal(attached.actionId, 'na-bare');
  assert.equal(attached.actions.find((row) => row.id === 'na-bare').meetLink, '', 'the pasted room is not copied by default');
  const planned = { meetingId: 'ff-plan', meetLink: ACTION_ROOM, startedAt: iso(SALES_AT + 2 * 24 * HOUR) };
  const slot = slots.resolveRecordingSlot(client, planned).slot;
  assert.equal(activity.attachFirefliesToMatchingAction(actions, planned, { slot }).actionId, 'na-plan');
  const workshop = { meetingId: 'ff-ws', meetLink: WORKSHOP_ROOM, startedAt: iso(SALES_AT + 10 * MIN) };
  assert.equal(activity.attachFirefliesToMatchingAction(actions, workshop, { slot: slots.resolveRecordingSlot(client, workshop).slot }).actionId, '', 'the workshop goes on no Møte action');
  assert.equal(activity.meetingMatchesAction({ meetLink: SALES_ROOM, startedAt: iso(SALES_AT + 2 * 24 * HOUR) }, actions[2]), false, 'never an action booked in another room');
  const kept = activity.attachFirefliesToMatchingAction([{ ...actions[2], firefliesMeetingId: 'ff-real' }], { ...planned, meetingId: 'ff-frag' }, {
    slot,
    keepCurrent: () => true,
  });
  assert.equal(kept.actionId, '', 'an action keeps the recording with more talk');
});

test('M15/M1: the activity log shows a placeholder\'s recording state without a Fireflies link, and logs one copy per meeting', () => {
  const client = bookedClient({
    meetings: [
      placeholder('workshop', WORKSHOP_AT, WORKSHOP_ROOM, { recording: { state: 'missing', message: 'Ingen Fireflies-opptak etter møtet.' } }),
      recording('ff-sales', SALES_ROOM, SALES_AT, { purpose: 'sales', sentenceCount: 400, durationMinutes: 50, transcriptUrl: 'https://app.fireflies.ai/view/ff-sales' }),
      recording('ff-frag', SALES_ROOM, SALES_AT + MIN, { purpose: 'sales', sentenceCount: 2, durationMinutes: 1 }),
    ],
  });
  const log = activity.buildClientActivityLog(client);
  const rows = log.sections.flatMap((section) => section.rows).filter((row) => row.meeting);
  const stub = rows.find((row) => row.meeting.placeholder);
  assert.ok(stub, 'the unrecorded workshop is in the log');
  assert.equal(stub.meeting.firefliesUrl, '');
  assert.equal(stub.meeting.recordingState, 'missing');
  assert.equal(stub.meeting.recordingMessage, 'Ingen Fireflies-opptak etter møtet.');
  assert.equal(rows.some((row) => row.meeting.meetingId === 'ff-frag'), false, 'the fragment is not logged as a second meeting');
  assert.equal(activity.firefliesUrlForMeeting({ meetingId: 'live:c1:1' }), '');
  assert.equal(log.meetingCount, 2, 'the placeholder is no recording');
});

test('M10: the offer lock never names a placeholder and prefers the sales recording with talk', () => {
  const client = bookedClient({
    progression: { meetingHeld: true },
    meetings: [
      placeholder('sales', SALES_AT, SALES_ROOM),
      { meetingId: 'ff-frag', purpose: 'sales', slotKey: `sales:${SALES_AT}`, hasTranscript: false, sentenceCount: 0, durationMinutes: 1 },
      { meetingId: 'ff-real', purpose: 'sales', slotKey: `sales:${SALES_AT}`, hasTranscript: true, sentenceCount: 420, durationMinutes: 51 },
      { meetingId: 'ff-ws', purpose: 'workshop', hasTranscript: true, sentenceCount: 900 },
    ],
  });
  assert.equal(sales.pickLockedOfferMeetingId(client), 'ff-real');
  assert.equal(sales.pickLockedOfferMeetingId({ ...client, meetings: [placeholder('sales', SALES_AT, SALES_ROOM)] }), '', 'only a placeholder: no lock yet');
  const talkOf = (row) => ({ sentences: Number(row.sentenceCount) || 0, minutes: Number(row.durationMinutes) || 0 });
  assert.equal(meetings.offerLockIsStale({ ...client, lockedOfferMeetingId: `live:c-booked:${SALES_AT}` }, { talkOf }), true);
  assert.equal(meetings.offerLockIsStale({ ...client, lockedOfferMeetingId: 'gone' }, { talkOf }), true);
  assert.equal(meetings.offerLockIsStale({ ...client, lockedOfferMeetingId: 'ff-real' }, { talkOf }), false);
  const sameMeeting = {
    ...client,
    lockedOfferMeetingId: 'ff-frag',
    meetings: client.meetings.map((row) => ({ ...row, meetLink: SALES_ROOM, startedAt: iso(SALES_AT) })),
  };
  assert.equal(meetings.offerLockIsStale(sameMeeting, { talkOf }), true, 'a fragment of the meeting gives way to the real recording');
});

test('M10: ticking "Møtet hatt" never keeps a placeholder lock', () => {
  const created = sales.createSalesClient({ businessName: 'Testfirma C AS', agreedTime: true, meetingAt: iso(SALES_AT), meetingMode: 'online' });
  const stubId = `live:${created.id}:${SALES_AT}`;
  sales.linkMeetingToSalesClient(created.id, { meetingId: stubId, linkedBy: 'live-join', purpose: 'sales', forSalesMeeting: true, startedAt: iso(SALES_AT), slotKey: `sales:${SALES_AT}` });
  sales.updateSalesClient(created.id, { lockedOfferMeetingId: stubId });
  sales.linkMeetingToSalesClient(created.id, {
    meetingId: 'ff-lock-real', linkedBy: 'meet-link', purpose: 'sales', forSalesMeeting: true, hasTranscript: true, startedAt: iso(SALES_AT), slotKey: `sales:${SALES_AT}`, sentenceCount: 50,
  });
  const ticked = sales.setSalesProgress(created.id, 'meetingHeld', true);
  assert.equal(ticked.progression.meetingHeld, true);
  assert.equal(ticked.lockedOfferMeetingId, 'ff-lock-real');
});

test('the card rows: placeholders have no link, a covered one is hidden, live captions and silent copies cover nothing', () => {
  ff.storeFirefliesMeeting({ meetingId: 'ff-card-live', title: 'Live', startedAt: iso(SALES_AT + MIN), meetingLink: SALES_ROOM, transcript: 'Kari: hei', isLive: true });
  ff.storeFirefliesMeeting({
    meetingId: 'ff-card-silent', title: 'Stille', startedAt: iso(SALES_AT), meetingLink: SALES_ROOM, transcript: '', summaryStatus: 'skipped', sentenceCount: 0, durationMinutes: 1,
  });
  const stub = placeholder('sales', SALES_AT, SALES_ROOM, { recording: { state: 'recording', lastSeenAt: iso(SALES_AT + 20 * MIN) } });
  const live = meetings.presentClientMeetings(bookedClient({
    meetings: [stub, recording('ff-card-live', SALES_ROOM, SALES_AT + MIN, { hasTranscript: true }), recording('ff-card-silent', SALES_ROOM, SALES_AT, { hasTranscript: false })],
  }), null, { media: false });
  const shownStub = live.find((row) => row.placeholder);
  assert.ok(shownStub, 'the bot is recording: live captions do not replace the placeholder');
  assert.equal(shownStub.transcriptUrl, '');
  assert.equal(live.find((row) => row.meetingId === 'ff-card-live').partial, true);
  assert.equal(live.find((row) => row.meetingId === 'ff-card-silent').duplicateOf, 'ff-card-live', 'the silent copy is a duplicate of the one with talk');
  // Fireflies finishes the meeting: the finished copy with talk covers the placeholder.
  ff.storeFetchedFirefliesMeeting({ meetingId: 'ff-card-live', isLive: false, summaryStatus: 'processed', transcript: 'Kari: hei\nSelger: hei', summary: 'Ny nettside.' });
  const done = meetings.presentClientMeetings(bookedClient({
    meetings: [stub, recording('ff-card-live', SALES_ROOM, SALES_AT + MIN, { hasTranscript: true })],
  }), null, { media: false });
  assert.equal(done.some((row) => row.placeholder), false);
  // A placeholder long past its deadline with nothing recorded stays (the watchdog says missing).
  const missing = meetings.presentClientMeetings(bookedClient({
    meetings: [placeholder('workshop', WORKSHOP_AT - 30 * 24 * HOUR, WORKSHOP_ROOM, { recording: { state: 'missing' } })],
  }), null, { media: false });
  assert.equal(missing.length, 1);
  assert.equal(missing[0].placeholder, true);
});

test('M6/M12: the workshop slot keeps the recording with talk, ignores ids no longer on the card, and follows a purpose change', () => {
  ff.storeFirefliesMeeting({ meetingId: 'ff-ws-real', title: 'Workshop', startedAt: iso(WORKSHOP_AT), meetingLink: WORKSHOP_ROOM, transcript: 'A\nB\nC\nD', sentenceCount: 4, durationMinutes: 30 });
  ff.storeFirefliesMeeting({ meetingId: 'ff-ws-frag', title: 'Workshop', startedAt: iso(WORKSHOP_AT + 2 * MIN), meetingLink: WORKSHOP_ROOM, transcript: '', summaryStatus: 'skipped', sentenceCount: 0, durationMinutes: 1 });
  const base = bookedClient({
    workshopAction: { ...bookedClient().workshopAction, firefliesMeetingId: 'ff-ws-real' },
    meetings: [recording('ff-ws-real', WORKSHOP_ROOM, WORKSHOP_AT, { purpose: 'workshop', sentenceCount: 4 })],
  });
  const fragment = meetings.applyFirefliesPurpose(base, recording('ff-ws-frag', WORKSHOP_ROOM, WORKSHOP_AT + 2 * MIN, { hasTranscript: false }));
  assert.equal(fragment.ref.purpose, 'workshop');
  assert.equal(fragment.workshopAction, null, 'an empty rejoin fragment never takes the workshop slot');
  const later = meetings.applyFirefliesPurpose(base, recording('ff-ws-next', WORKSHOP_ROOM, WORKSHOP_AT + 9 * 24 * HOUR, { sentenceCount: 2 }));
  assert.equal(later.workshopAction?.firefliesMeetingId, 'ff-ws-next', 'a later workshop meeting takes the slot, as before');
  assert.equal(meetings.meetingIdForPurpose(base, 'workshop'), 'ff-ws-real');
  assert.equal(meetings.meetingIdForPurpose({ ...base, meetings: [] }, 'workshop'), '', 'a slot id that left the card is another client\'s now');
  const retagged = { ...base, meetings: [recording('ff-ws-real', SALES_ROOM, SALES_AT, { purpose: 'sales' })] };
  assert.equal(meetings.meetingIdForPurpose(retagged, 'workshop'), '', 'a slot id whose recording is the sales meeting now is not the workshop');
});

test('sync: rows linked before the rules get their purpose, slot and sentence count; covered placeholders are listed; a person\'s pick stays', () => {
  ff.storeFirefliesMeeting({ meetingId: 'ff-sync-1', title: 'Salg', startedAt: iso(SALES_AT + MIN), meetingLink: SALES_ROOM, transcript: 'A\nB', sentenceCount: 2 });
  const stub = placeholder('sales', SALES_AT, SALES_ROOM);
  const plan = meetings.planClientMeetingSync(bookedClient({
    meetings: [
      stub,
      // Tagged by the old clock rule; the room says sales.
      recording('ff-sync-1', SALES_ROOM, SALES_AT + MIN, { purpose: 'workshop', hasTranscript: true }),
      recording('ff-sync-2', WORKSHOP_ROOM, WORKSHOP_AT, { purpose: 'sales', purposePickedAt: iso(WORKSHOP_AT), hasTranscript: false }),
    ],
  }));
  const patch = plan.patches.find((entry) => entry.meetingId === 'ff-sync-1')?.patch;
  assert.deepEqual([patch.purpose, patch.slotKey, patch.forSalesMeeting, patch.sentenceCount], ['sales', `sales:${SALES_AT}`, true, 2]);
  assert.equal(plan.patches.some((entry) => entry.meetingId === 'ff-sync-2'), false);
  assert.deepEqual(plan.drop, [stub.meetingId]);
});

test('a person\'s purpose pick puts the recording on that slot; "" goes back to automatic', () => {
  const client = bookedClient();
  const row = recording('ff-pick', OTHER_ROOM, WORKSHOP_AT + 6 * HOUR);
  const picked = meetings.purposePickPatch(client, row, 'workshop', { by: 'Kari Test', nowMs: WORKSHOP_AT });
  assert.deepEqual(
    [picked.purpose, picked.slotKey, picked.forSalesMeeting, picked.purposePickedBy, picked.purposePickedAt],
    ['workshop', `workshop:${WORKSHOP_AT}`, false, 'Kari Test', iso(WORKSHOP_AT)],
  );
  const back = meetings.purposePickPatch(client, { ...row, ...picked, meetLink: WORKSHOP_ROOM, startedAt: iso(WORKSHOP_AT + 3 * MIN) }, '');
  assert.deepEqual([back.purpose, back.slotKey, back.purposePickedAt], ['workshop', `workshop:${WORKSHOP_AT}`, '']);
});

test('M11/F13: the stored match says what the card says, a person pins it, exclusions are kept, and nothing is written for no change', () => {
  ff.storeFirefliesMeeting({ meetingId: 'ff-store-1', title: 'Salg', startedAt: iso(SALES_AT), meetingLink: SALES_ROOM, transcript: 'A' });
  const match = ff.storedMatchForCard({ id: 'c-booked', businessName: 'Testfirma AS' }, { linkedBy: 'manual', purpose: 'sales', slotKey: `sales:${SALES_AT}`, confidence: 'manual' });
  const first = ff.setStoredFirefliesClientLink('ff-store-1', { match, pin: { clientId: 'c-booked', linkedBy: 'manual' }, include: 'c-booked' }, { nowMs: SALES_AT });
  assert.deepEqual([first.match.clientId, first.match.purpose, first.match.slotKey, first.pin.clientId], ['c-booked', 'sales', `sales:${SALES_AT}`, 'c-booked']);
  const again = ff.setStoredFirefliesClientLink('ff-store-1', { match, pin: { clientId: 'c-booked', linkedBy: 'manual' } }, { nowMs: SALES_AT + HOUR });
  assert.equal(again.updatedAt, first.updatedAt, 'the same link writes nothing');
  assert.equal(again.match.linkedAt, first.match.linkedAt);
  const excluded = ff.setStoredFirefliesClientLink('ff-store-1', { exclude: 'c-booked', pin: null, match: null }, { nowMs: SALES_AT + 2 * HOUR });
  assert.deepEqual([excluded.excludedClientIds, excluded.pin, excluded.match], [['c-booked'], null, null]);
  // A fresh copy from Fireflies keeps the pin and the exclusions.
  const merged = ff.storeFetchedFirefliesMeeting({ meetingId: 'ff-store-1', transcript: 'A\nB', summaryStatus: 'processed' });
  assert.deepEqual(merged.excludedClientIds, ['c-booked']);
  assert.equal(ff.setStoredFirefliesClientLink('ff-missing', { match }), null, 'only a stored record is touched');
  // The sweep: one write sets every match to the card that holds it, or nothing.
  ff.storeFirefliesMeeting({ meetingId: 'ff-store-2', title: 'Ukoblet', startedAt: iso(SALES_AT), meetingLink: OTHER_ROOM, transcript: 'A', match: { clientId: 'c-stale', linkedBy: 'auto' } });
  const synced = ff.syncStoredFirefliesMatches([
    { meetingId: 'ff-store-1', match },
    { meetingId: 'ff-store-2', match: null },
  ]);
  assert.equal(synced.changed, 2);
  assert.equal(ff.readStoredFirefliesMeeting('ff-store-2').match, null);
  assert.equal(ff.syncStoredFirefliesMatches([{ meetingId: 'ff-store-1', match }]).changed, 0);
  // Unmatched means on no client's card.
  const holders = new Map([['ff-store-1', 'c-booked']]);
  const unmatched = ff.listStoredFirefliesMeetings({ unmatchedOnly: true, holders }).map((row) => row.meetingId);
  assert.ok(unmatched.includes('ff-store-2'));
  assert.equal(unmatched.includes('ff-store-1'), false);
  assert.deepEqual(ff.listStoredFirefliesMeetings({ clientId: 'c-booked', holders }).map((row) => row.meetingId), ['ff-store-1']);
});

test('the compact ref carries the sentence count; the webhook keeps the match the link synced', async () => {
  assert.equal(ff.meetingRefForClient({ meetingId: 'x', transcript: 'A\nB\n\nC' }).sentenceCount, 3);
  assert.equal(ff.meetingRefForClient({ meetingId: 'x', sentenceCount: 0 }).sentenceCount, 0);
  assert.equal(ff.meetingRefForClient({ meetingId: 'x' }).sentenceCount, '');
  const linked = [];
  const result = await ff.notifyFirefliesRecording(
    { meetingId: 'ff-hook-1', eventType: 'Transcription completed' },
    { apiKey: 'test-key', notifyEmail: 'ansatte@asoldi.com' },
    {
      fetchTranscript: async () => ({ id: 'ff-hook-1', title: 'Salg', meeting_link: SALES_ROOM, dateString: iso(SALES_AT), sentences: [{ speaker_name: 'Kari', text: 'Hei' }], is_live: false, meeting_info: { summary_status: 'processing' } }),
      matchClients: () => ({ best: { clientId: 'c-booked', businessName: 'Testfirma AS', confidence: 'high' }, candidates: [] }),
      // The server's link writes the card's match (purpose, slot) onto the stored record.
      linkMeeting: (clientId, ref) => {
        linked.push(ref);
        ff.setStoredFirefliesClientLink(ref.meetingId, { match: ff.storedMatchForCard({ id: clientId, businessName: 'Testfirma AS' }, { ...ref, purpose: 'sales', slotKey: `sales:${SALES_AT}` }) });
      },
      sendEmail: async () => {},
    },
  );
  assert.equal(linked.length, 1);
  assert.equal(result.match?.slotKey, `sales:${SALES_AT}`);
  assert.equal(ff.readStoredFirefliesMeeting('ff-hook-1').match.purpose, 'sales', 'not overwritten by the bare automatic match');
});

test('data/sales.js keeps the new row fields and patches rows of several clients in one write', () => {
  const a = sales.createSalesClient({ businessName: 'Testfirma A AS' });
  const b = sales.createSalesClient({ businessName: 'Testfirma B AS' });
  sales.linkMeetingToSalesClient(a.id, { meetingId: 'ff-row-a', title: 'A', sentenceCount: '12', purposePickedBy: 'Kari Test', purposePickedAt: iso(SALES_AT) });
  sales.linkMeetingToSalesClient(b.id, { meetingId: 'ff-row-b', title: 'B' });
  const row = sales.getSalesClientById(a.id).meetings[0];
  assert.deepEqual([row.sentenceCount, row.purposePickedBy, row.purposePickedAt], [12, 'Kari Test', iso(SALES_AT)]);
  assert.equal(sales.getSalesClientById(b.id).meetings[0].sentenceCount, '');
  const changed = sales.patchSalesMeetingRows([
    { clientId: a.id, meetingId: 'ff-row-a', patch: { purpose: 'sales', slotKey: 'sales:1' } },
    { clientId: b.id, meetingId: 'ff-row-b', patch: { purpose: 'workshop', recording: { state: 'missing' } } },
    { clientId: b.id, meetingId: 'gone', patch: { purpose: 'sales' } },
  ]);
  assert.equal(changed, 2);
  assert.equal(sales.getSalesClientById(a.id).meetings[0].slotKey, 'sales:1');
  const rowB = sales.getSalesClientById(b.id).meetings[0];
  assert.deepEqual([rowB.purpose, rowB.recording], ['workshop', null], 'a recording state is not set through a row patch');
});

test('server.js: every link goes through linkFirefliesMeeting with the person, slot, lock and match rules', () => {
  const server = readFileSync(fileURLToPath(new URL('../server.js', import.meta.url)), 'utf8');
  const between = (from, to) => server.slice(server.indexOf(from), server.indexOf(to, server.indexOf(from) + from.length));
  const link = between('function linkFirefliesMeeting(', 'function unlinkFirefliesMeetingFromClient(');
  assert.match(link, /if \(!human && automaticLinkRefusal\(meetingId, client\.id, \{ stored: readStoredFirefliesMeeting\(meetingId\), clients \}\)\) \{\s*return client;/);
  assert.match(link, /for \(const holder of holders\) detachMeetingFromClient\(holder\.id, meetingId\);/);
  assert.match(link, /dropSupersededPlaceholders\(client\.id\)/);
  assert.match(link, /repointOfferLock\(client\.id, \{ talkOf \}\);/);
  assert.match(link, /syncStoredClientLink\(client\.id, meetingId, \{ human, actor: ref\.linkedBy \}\);/);
  assert.equal(link.includes('recordingMatchesSalesMeeting'), false, 'the room decides the purpose, not the clock');
  const deps = between('function firefliesClientDeps()', 'const firefliesMediaInFlight');
  assert.match(deps, /matchClients: async \(record\) => matchRecordingToClients\(record\),/);
  assert.equal(deps.includes('salesOwnerEmailMap'), false, 'no owner e-mail lookups per webhook');
  const view = between('function canViewMeeting(', "app.get('/api/admin/fireflies/meetings', salesAuth");
  assert.match(view, /sales\.findSalesClientByMeetingId\(/);
  assert.equal(view.includes('match?.clientId'), false);
  const media = between("app.get('/api/admin/fireflies/meetings/:meetingId/media/:kind'", "app.post('/api/admin/sales/:id/open-meet'");
  assert.match(media, /if \(!canViewMeeting\(req, record\)\) return res\.status\(403\)/);
  const backfill = between('function applyFirefliesMeetLinkBackfill(', 'let firefliesMeetLinkBackfillAt');
  assert.match(backfill, /slotOwner: slotOwnerAmongClients/);
  assert.match(backfill, /syncClientMeetingFacts\(/);
  assert.match(backfill, /syncFirefliesMatchesToCards\(/);
  const guard = between('function ensureFirefliesMeetLinkBackfill(', 'function clientAfterFirefliesBackfill(');
  assert.match(guard, /if \(firefliesStoreSource\('meetings'\) === 'unreadable'\) return firefliesMeetLinkBackfillSummary;/);
  const paste = between("app.post('/api/admin/sales/:id/offer/use-meeting'", "app.post('/api/admin/sales/:id/offer/request-review'");
  assert.match(paste, /if \(holder && holder\.id !== client\.id && !req\.salesUser\?\.isAdmin\) \{\s*return res\.status\(409\)/);
  assert.match(paste, /const holders = req\.salesUser\?\.isAdmin \? null : firefliesHolderMap\(\);/);
  const offerMeeting = between('function presentMeetingForOffer(', 'function presentOfferMeetings(');
  assert.equal(offerMeeting.includes('firefliesLiveJoinedAt'), false, 'never from the calendar\'s live-join stamps');
  assert.match(offerMeeting, /liveJoined: recordingState === 'recording',/);
  assert.match(offerMeeting, /pendingTranscript: !hasTranscript && !hasSummary && offerMeetingPending\(meeting\),/);
  const compact = between('function compactOfferClient(', 'function presentOffer(');
  assert.match(compact, /filter\(\(row\) => !isPlaceholderMeetingId\(row\?\.meetingId\)\)/);
  assert.match(server, /unmatchedMeetings: listStoredFirefliesMeetings\(\{ unmatchedOnly: true, holders: firefliesHolderMap\(\) \}\)\.length,/);
});

test('server.js: the purpose and exclude routes check access and keep a person\'s word', () => {
  const server = readFileSync(fileURLToPath(new URL('../server.js', import.meta.url)), 'utf8');
  const between = (from, to) => server.slice(server.indexOf(from), server.indexOf(to, server.indexOf(from) + from.length));
  const purpose = between("app.post('/api/admin/sales/:id/meetings/:meetingId/purpose'", "app.post('/api/admin/fireflies/meetings/:meetingId/refresh'");
  assert.match(purpose, /salesAuth/);
  assert.match(purpose, /if \(!canAccessSalesClient\(req, client\)\) return res\.status\(403\)/);
  assert.match(purpose, /\['', 'sales', 'workshop', 'iteration'\]\.includes\(purpose\)/);
  assert.match(purpose, /res\.json\(\{ client: jsonSalesClient\(updated \|\| client\) \}\);/);
  const exclude = between("app.post('/api/admin/fireflies/meetings/:meetingId/exclude'", "app.post('/api/admin/sales/:id/meetings/:meetingId/purpose'");
  assert.match(exclude, /if \(!canAccessSalesClient\(req, client\)\) return res\.status\(403\)/);
  assert.match(exclude, /exclude: client\.id,/);
  assert.match(exclude, /res\.json\(\{ ok: true, client: jsonSalesClient\(/);
  const unlink = between("app.post('/api/admin/fireflies/meetings/:meetingId/unlink'", "app.post('/api/admin/fireflies/meetings/:meetingId/exclude'");
  assert.match(unlink, /sales\.findSalesClientByMeetingId\(record\.meetingId\)/);
  assert.match(unlink, /exclude: holder\.id/);
});
