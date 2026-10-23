// Recordings on and off client cards (lib/fireflies-linking.js), run against the real sales file and
// Fireflies archive in a throwaway data dir: a person's move cleans up the card it leaves and pins the
// recording (M7/M11/M12), automatic links never undo a person or an exclusion, a placeholder goes only
// for real talk on its slot (M5/F15), a purpose pick moves the slot and the offer lock (M4/M10), "Ikke
// denne kunden" holds (M7), and the backfill repairs what the old hub left (M6/M10).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-ff-linking-'));
process.env.APP_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const sales = await import('../data/sales.js');
const ff = await import('../lib/fireflies-webhook.js');
const { createFirefliesLinker } = await import('../lib/fireflies-linking.js');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();
const T = Date.parse('2026-10-20T10:00:00.000Z');
const W = T + 3 * DAY;
const room = (code) => `https://meet.google.com/${code}`;
const talk = (count) => Array.from({ length: count }, (_, index) => `Kari Test: setning ${index + 1}.`).join('\n');

const stripped = [];
const workshopDocs = [];
const linker = createFirefliesLinker({
  sales,
  stripFromOffer: (clientId, meetingId) => stripped.push([clientId, meetingId]),
  onWorkshopRecording: (clientId) => workshopDocs.push(clientId),
  log: { warn: () => {}, log: () => {} },
});

function makeClient(businessName, { meet, workshopMeet = '' } = {}) {
  return sales.createSalesClient({
    businessName,
    agreedTime: true,
    meetingAt: iso(T),
    meetingMode: 'online',
    calendar: { meetLink: meet, confirmedMeetLink: meet },
    ...(workshopMeet
      ? { workshopAction: { name: 'Workshop', format: 'mote', dueAt: iso(W), meetLink: workshopMeet, status: 'confirmed' } }
      : {}),
  });
}

function store(meetingId, meet, startMs, { sentences = 40, minutes = 45, ...rest } = {}) {
  return ff.storeFirefliesMeeting({
    meetingId,
    title: 'Møte',
    startedAt: iso(startMs),
    meetingLink: meet,
    transcript: talk(sentences),
    sentenceCount: sentences,
    durationMinutes: minutes,
    summaryStatus: 'processed',
    ...rest,
  });
}

function ref(meetingId, linkedBy = 'meet-link') {
  return ff.meetingRefForClient(ff.readStoredFirefliesMeeting(meetingId), { linkedBy }, { linkedBy });
}

function rowOn(clientId, meetingId) {
  return (sales.getSalesClientById(clientId)?.meetings || []).find((row) => row.meetingId === meetingId) || null;
}

function placeholder(client, { meet, state = 'ended' } = {}) {
  const meetingId = `live:${client.id}:${T}`;
  sales.linkMeetingToSalesClient(client.id, {
    meetingId,
    startedAt: iso(T),
    meetLink: meet,
    hasTranscript: false,
    linkedBy: 'live-join',
    source: 'live-join',
    purpose: 'sales',
    forSalesMeeting: true,
    slotKey: `sales:${T}`,
    recording: { state },
  });
  return meetingId;
}

test('a person moves a recording: the card it leaves loses its slots, offer entry and lock; the new one holds it pinned', () => {
  const a = makeClient('Testfirma A AS', { meet: room('aaa-aaaa-aaa'), workshopMeet: room('aaw-aaaa-aaw') });
  const b = makeClient('Testfirma B AS', { meet: room('bbb-bbbb-bbb') });
  store('ff-move-ws', room('aaw-aaaa-aaw'), W + MIN);
  store('ff-move-sales', room('aaa-aaaa-aaa'), T + MIN, { sentences: 300 });
  store('ff-move-other', room('aaa-aaaa-aaa'), T + DAY, { sentences: 80 });
  workshopDocs.length = 0;
  linker.link(a.id, ref('ff-move-ws'));
  linker.link(a.id, ref('ff-move-sales'));
  linker.link(a.id, ref('ff-move-other'));
  assert.equal(sales.getSalesClientById(a.id).workshopAction.firefliesMeetingId, 'ff-move-ws');
  assert.deepEqual(workshopDocs, [a.id], 'the workshop recording starts the project document');
  assert.equal(rowOn(a.id, 'ff-move-sales').slotKey, `sales:${T}`);
  const booked = sales.getSalesClientById(a.id).nextActions.find((action) => action.presetKey === 'meeting');
  assert.equal(booked.firefliesMeetingId, 'ff-move-sales', 'on the booked Møte, which a recording a day later in its room does not take');
  sales.updateSalesClient(a.id, { progression: { meetingHeld: true } });
  assert.equal(linker.repointLock(a.id).lockedOfferMeetingId, 'ff-move-sales');

  stripped.length = 0;
  linker.link(b.id, ref('ff-move-ws', 'admin:superadmin'));
  linker.link(b.id, ref('ff-move-sales', 'admin:superadmin'));
  const left = sales.getSalesClientById(a.id);
  assert.equal(rowOn(a.id, 'ff-move-ws'), null);
  assert.equal(rowOn(a.id, 'ff-move-sales'), null);
  assert.equal(left.workshopAction.firefliesMeetingId, '', 'the workshop slot no longer reads another client\'s workshop');
  assert.equal(left.nextActions.some((action) => action.firefliesMeetingId === 'ff-move-sales'), false);
  assert.deepEqual(stripped, [[a.id, 'ff-move-ws'], [a.id, 'ff-move-sales']], 'off its open offer');
  assert.equal(left.lockedOfferMeetingId, 'ff-move-other', 'the lock follows the sales recording still on the card');
  assert.equal(rowOn(b.id, 'ff-move-sales').linkedBy, 'admin:superadmin');
  const stored = ff.readStoredFirefliesMeeting('ff-move-sales');
  assert.deepEqual([stored.pin.clientId, stored.match.clientId, stored.match.linkedBy], [b.id, b.id, 'admin:superadmin']);
  // The room is A's, but a person said B: the backfill leaves it there.
  linker.backfill();
  assert.equal(sales.findSalesClientByMeetingId('ff-move-sales').id, b.id);
});

test('an automatic link never undoes a person or an exclusion; a person\'s link lifts the exclusion', () => {
  const owner = makeClient('Testfirma Eier AS', { meet: room('ccc-cccc-ccc') });
  const other = makeClient('Testfirma Annen AS', { meet: room('ddd-dddd-ddd') });
  store('ff-pin', room('ccc-cccc-ccc'), T + MIN);
  linker.link(other.id, ref('ff-pin', 'sales:rep-1'));
  assert.equal(ff.readStoredFirefliesMeeting('ff-pin').pin.clientId, other.id);
  assert.equal(linker.refusal(owner.id, ref('ff-pin')), 'pinned');
  const refused = linker.tryLink(owner.id, ref('ff-pin'));
  assert.deepEqual([refused.refused, refused.client.id], ['pinned', owner.id], 'the refused link says why and answers with the client as it is');
  assert.equal(sales.findSalesClientByMeetingId('ff-pin').id, other.id);
  linker.link(other.id, ref('ff-pin'));
  assert.equal(rowOn(other.id, 'ff-pin').linkedBy, 'sales:rep-1', 'a later automatic relink keeps it a person\'s link');

  store('ff-excluded', room('ccc-cccc-ccc'), T + 2 * HOUR);
  ff.setStoredFirefliesClientLink('ff-excluded', { exclude: owner.id });
  assert.equal(linker.refusal(owner.id, ref('ff-excluded')), 'excluded');
  linker.link(owner.id, ref('ff-excluded'));
  assert.equal(rowOn(owner.id, 'ff-excluded'), null);
  linker.link(owner.id, ref('ff-excluded', 'manual'));
  assert.ok(rowOn(owner.id, 'ff-excluded'), 'a person may put it back');
  const stored = ff.readStoredFirefliesMeeting('ff-excluded');
  assert.deepEqual([stored.excludedClientIds, stored.pin.clientId], [[], owner.id]);
});

test('a placeholder goes only when a recording with real talk covers its slot', () => {
  const client = makeClient('Testfirma Plass AS', { meet: room('eee-eeee-eee') });
  const stubId = placeholder(client, { meet: room('eee-eeee-eee') });
  store('ff-hallo', room('eee-eeee-eee'), T - 2 * MIN, { sentences: 1, minutes: 1 });
  linker.link(client.id, ref('ff-hallo'));
  assert.ok(rowOn(client.id, stubId), 'a "hallo?" before the meeting is not the meeting');
  store('ff-meeting', room('eee-eeee-eee'), T + 2 * MIN, { sentences: 300, minutes: 50 });
  stripped.length = 0;
  linker.link(client.id, ref('ff-meeting'));
  assert.equal(rowOn(client.id, stubId), null);
  assert.deepEqual(stripped, [[client.id, stubId]]);
});

test('a purpose pick moves the slot and the offer lock; a pick weeks later covers no booked meeting', () => {
  const client = makeClient('Testfirma Formål AS', { meet: room('fff-ffff-fff'), workshopMeet: room('ffw-ffff-ffw') });
  store('ff-pick-ws', room('ofo-ffff-ofo'), W + 5 * HOUR);
  linker.link(client.id, ref('ff-pick-ws', 'manual'));
  assert.equal(rowOn(client.id, 'ff-pick-ws').purpose, '', 'another room five hours late: nothing says it is the workshop');
  workshopDocs.length = 0;
  const picked = linker.setPurpose(client.id, 'ff-pick-ws', 'workshop', { by: 'Kari Test', actor: 'sales:rep-1', nowMs: W + 6 * HOUR });
  const row = rowOn(client.id, 'ff-pick-ws');
  assert.deepEqual([row.purpose, row.slotKey, row.purposePickedBy, row.purposePickedAt], ['workshop', `workshop:${W}`, 'Kari Test', iso(W + 6 * HOUR)]);
  assert.equal(picked.workshopAction.firefliesMeetingId, 'ff-pick-ws');
  assert.deepEqual(workshopDocs, [client.id]);
  assert.deepEqual([ff.readStoredFirefliesMeeting('ff-pick-ws').pin.clientId, ff.readStoredFirefliesMeeting('ff-pick-ws').match.purpose], [client.id, 'workshop']);
  const back = linker.setPurpose(client.id, 'ff-pick-ws', '');
  assert.deepEqual([rowOn(client.id, 'ff-pick-ws').purpose, rowOn(client.id, 'ff-pick-ws').purposePickedAt], ['', '']);
  assert.equal(back.workshopAction.firefliesMeetingId, '', 'back to automatic: the workshop slot lets go');

  store('ff-lock-a', room('fff-ffff-fff'), T + MIN, { sentences: 100 });
  store('ff-lock-b', room('ofo-ffff-ofo'), T + 4 * HOUR, { sentences: 60 });
  linker.link(client.id, ref('ff-lock-a'));
  linker.link(client.id, ref('ff-lock-b', 'manual'));
  sales.updateSalesClient(client.id, { progression: { meetingHeld: true } });
  assert.equal(linker.repointLock(client.id).lockedOfferMeetingId, 'ff-lock-a');
  assert.equal(linker.setPurpose(client.id, 'ff-lock-b', 'sales', { by: 'Kari Test' }).lockedOfferMeetingId, 'ff-lock-b', 'a person\'s "Salgsmøte" moves the lock');
  assert.equal(linker.setPurpose(client.id, 'ff-lock-b', 'workshop', { by: 'Kari Test' }).lockedOfferMeetingId, 'ff-lock-a', 'and off it again');

  const far = makeClient('Testfirma Langt AS', { meet: room('ggg-gggg-ggg') });
  const stubId = placeholder(far, { meet: room('ggg-gggg-ggg'), state: 'missing' });
  store('ff-far', room('ogo-gggg-ogo'), T + 21 * DAY, { sentences: 200 });
  linker.link(far.id, ref('ff-far', 'manual'));
  linker.setPurpose(far.id, 'ff-far', 'sales', { by: 'Kari Test' });
  assert.deepEqual([rowOn(far.id, 'ff-far').purpose, rowOn(far.id, 'ff-far').slotKey], ['sales', '']);
  assert.equal(rowOn(far.id, stubId)?.recording?.state, 'missing', 'the booked meeting that was not recorded stays visible');
});

test('"Ikke denne kunden" keeps a recording off the client, also one that was never stored', () => {
  const client = makeClient('Testfirma Ikke AS', { meet: room('hhh-hhhh-hhh') });
  store('ff-not', room('hhh-hhhh-hhh'), T + MIN);
  linker.link(client.id, ref('ff-not'));
  stripped.length = 0;
  const result = linker.exclude(client.id, 'ff-not');
  assert.deepEqual([result.ok, result.status], [true, 200]);
  assert.equal(rowOn(client.id, 'ff-not'), null);
  assert.deepEqual(stripped, [[client.id, 'ff-not']]);
  const stored = ff.readStoredFirefliesMeeting('ff-not');
  assert.deepEqual([stored.excludedClientIds, stored.match], [[client.id], null]);
  linker.link(client.id, ref('ff-not'));
  linker.backfill();
  assert.equal(rowOn(client.id, 'ff-not'), null, 'its own room does not bring it back');

  sales.linkMeetingToSalesClient(client.id, { meetingId: 'ff-unstored', meetLink: room('hhh-hhhh-hhh'), startedAt: iso(T + 2 * DAY), hasTranscript: true, linkedBy: 'meet-link' });
  assert.equal(ff.readStoredFirefliesMeeting('ff-unstored'), null);
  assert.equal(linker.exclude(client.id, 'ff-unstored').ok, true);
  assert.equal(rowOn(client.id, 'ff-unstored'), null);
  assert.deepEqual(ff.readStoredFirefliesMeeting('ff-unstored').excludedClientIds, [client.id], 'a bare record keeps the exclusion');
  assert.equal(linker.refusal(client.id, { meetingId: 'ff-unstored', linkedBy: 'meet-link' }), 'excluded');
  assert.equal(linker.exclude(client.id, 'ff-nowhere').status, 404);
});

test('the admin unlink takes a recording off its card and keeps it off that client', () => {
  const client = makeClient('Testfirma Admin AS', { meet: room('iii-iiii-iii') });
  store('ff-admin', room('iii-iiii-iii'), T + MIN);
  linker.link(client.id, ref('ff-admin', 'admin:superadmin'));
  const after = linker.unlinkFromHolder('ff-admin');
  assert.equal(rowOn(client.id, 'ff-admin'), null);
  assert.deepEqual([after.excludedClientIds, after.pin, after.match], [[client.id], null, null]);
});

test('the backfill moves an old fragment slot and a lock left by a move, re-tags rows, and is idempotent', () => {
  const client = makeClient('Testfirma Rydd AS', { meet: room('jjj-jjjj-jjj'), workshopMeet: room('jjw-jjjj-jjw') });
  const elsewhere = makeClient('Testfirma Annet AS', { meet: room('kkk-kkkk-kkk') });
  store('ff-bf-frag', room('jjw-jjjj-jjw'), W, { sentences: 0, minutes: 1, summaryStatus: 'skipped' });
  store('ff-bf-main', room('jjw-jjjj-jjw'), W + 4 * MIN, { sentences: 250, minutes: 85 });
  store('ff-bf-sales', room('jjj-jjjj-jjj'), T + MIN, { sentences: 120 });
  store('ff-bf-moved', room('kkk-kkkk-kkk'), T + MIN, { sentences: 90 });
  // As the old hub left them: rows with no purpose, the workshop slot on the silent fragment, and the
  // lock on a recording that was moved to another client.
  for (const [meetingId, meet, startMs, hasTranscript] of [
    ['ff-bf-frag', room('jjw-jjjj-jjw'), W, false],
    ['ff-bf-main', room('jjw-jjjj-jjw'), W + 4 * MIN, true],
    ['ff-bf-sales', room('jjj-jjjj-jjj'), T + MIN, true],
  ]) {
    sales.linkMeetingToSalesClient(client.id, { meetingId, meetLink: meet, startedAt: iso(startMs), hasTranscript, linkedBy: 'meet-link' });
  }
  sales.linkMeetingToSalesClient(elsewhere.id, { meetingId: 'ff-bf-moved', meetLink: room('kkk-kkkk-kkk'), startedAt: iso(T + MIN), hasTranscript: true, linkedBy: 'meet-link' });
  sales.updateSalesClient(client.id, {
    workshopAction: { ...sales.getSalesClientById(client.id).workshopAction, firefliesMeetingId: 'ff-bf-frag' },
    progression: { meetingHeld: true },
    lockedOfferMeetingId: 'ff-bf-moved',
  });
  workshopDocs.length = 0;
  const plan = linker.backfill();
  const fixed = sales.getSalesClientById(client.id);
  assert.equal(fixed.workshopAction.firefliesMeetingId, 'ff-bf-main', 'the slot names the copy with talk');
  assert.ok(workshopDocs.includes(client.id), 'the project document is made from it');
  assert.equal(fixed.lockedOfferMeetingId, 'ff-bf-sales', 'never another client\'s recording');
  assert.ok(plan.slotsMoved >= 1 && plan.locksMoved >= 1 && plan.patched >= 3);
  assert.deepEqual([rowOn(client.id, 'ff-bf-main').purpose, rowOn(client.id, 'ff-bf-main').slotKey], ['workshop', `workshop:${W}`]);
  assert.deepEqual([rowOn(client.id, 'ff-bf-frag').sentenceCount, rowOn(client.id, 'ff-bf-main').sentenceCount], [0, 250]);
  const match = ff.readStoredFirefliesMeeting('ff-bf-main').match;
  assert.deepEqual([match.clientId, match.purpose, match.slotKey], [client.id, 'workshop', `workshop:${W}`]);
  const again = linker.backfill();
  assert.deepEqual(
    [again.moves.length, again.unlinks.length, again.patched, again.dropped, again.slotsMoved, again.locksMoved],
    [0, 0, 0, 0, 0, 0],
    'a second run changes nothing',
  );
});

test('the backfill moving a workshop slot to the longer copy keeps the project document and its ticked to-dos', async () => {
  const { applyWorkshopTranscriptToRecord, markProjectTodoDone, persistProjectDocument } = await import('../lib/workshop-project-document.js');
  const { getWorkshopRecord } = await import('../lib/workshop-record.js');
  const { meetingIdForPurpose } = await import('../lib/workshop-meetings.js');
  const workshopRoom = room('llw-llll-llw');
  const client = makeClient('Testfirma Kopi AS', { meet: room('lll-llll-lll'), workshopMeet: workshopRoom });
  // Two notetakers in one workshop: the old hub's slot and document are on the shorter copy.
  store('ff-ws-short', workshopRoom, W, { sentences: 80, minutes: 40 });
  store('ff-ws-long', workshopRoom, W + 2 * MIN, { sentences: 300, minutes: 85 });
  for (const [meetingId, startMs] of [['ff-ws-short', W], ['ff-ws-long', W + 2 * MIN]]) {
    sales.linkMeetingToSalesClient(client.id, { meetingId, meetLink: workshopRoom, startedAt: iso(startMs), hasTranscript: true, linkedBy: 'meet-link' });
  }
  let document = persistProjectDocument({
    meetingId: 'ff-ws-short',
    goalExplanation: 'Kunden skal kunne booke time.',
    clientDocumentation: 'Lokalt bakeri.',
    todos: [{ title: 'Booking' }, { title: 'Meny' }, { title: 'Farger' }],
  });
  document = markProjectTodoDone(markProjectTodoDone(document, 'todo-1', true), 'todo-2', true);
  sales.setSalesWorkshop(client.id, { ...getWorkshopRecord(sales.getSalesClientById(client.id)), projectDocument: document });
  sales.updateSalesClient(client.id, {
    workshopAction: { ...sales.getSalesClientById(client.id).workshopAction, firefliesMeetingId: 'ff-ws-short' },
  });
  workshopDocs.length = 0;
  linker.backfill();
  const moved = sales.getSalesClientById(client.id);
  assert.equal(moved.workshopAction.firefliesMeetingId, 'ff-ws-long');
  assert.ok(workshopDocs.includes(client.id));
  // What the project document job then does (server.js applyWorkshopProjectDocumentJob).
  const workshopMeeting = ff.readStoredFirefliesMeeting(meetingIdForPurpose(moved, 'workshop'));
  assert.equal(workshopMeeting.meetingId, 'ff-ws-long');
  const result = await applyWorkshopTranscriptToRecord({
    client: moved,
    workshopMeeting,
    evaluate: async () => { throw new Error('the workshop is not evaluated again'); },
    generateDocument: async () => { throw new Error('the project document is not written again'); },
  });
  assert.equal(result.skipped, 'already-applied');
  const kept = getWorkshopRecord(sales.getSalesClientById(client.id)).projectDocument;
  assert.deepEqual(kept.todos.map((todo) => todo.done), [true, true, false]);
  // A recording of another workshop (another day in the room) is still a new document.
  const other = { ...moved, meetings: [...moved.meetings, { meetingId: 'ff-ws-later', meetLink: workshopRoom, startedAt: iso(W + DAY), hasTranscript: true }] };
  const again = await applyWorkshopTranscriptToRecord({
    client: other,
    workshopMeeting: { meetingId: 'ff-ws-later', transcript: talk(200) },
    evaluate: async () => ({ meetingId: 'ff-ws-later', valid: true, reason: 'valid', source: 'ai' }),
    generateDocument: async () => persistProjectDocument({ meetingId: 'ff-ws-later', goalExplanation: 'Ny workshop.', todos: [{ title: 'Ny' }] }),
  });
  assert.equal(again.workshop.projectDocument.meetingId, 'ff-ws-later');
});
