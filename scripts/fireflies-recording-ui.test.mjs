// Sales UI: what the hub says about each booked meeting's Fireflies recording (app/pages/Admin/sections/
// firefliesRecording.ts), and the screens that must show it. The .ts helpers load as-is (Node strips types).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const h = await import(new URL('../app/pages/Admin/sections/firefliesRecording.ts', import.meta.url).href);
const { answerMeansMissingRoute } = await import(new URL('../app/pages/sales/hubRoute.ts', import.meta.url).href);
const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

const MIN = 60_000;
const START = Date.parse('2026-10-23T10:00:00.000Z'); // 12:00 in Oslo
const at = (minutes) => new Date(START + minutes * MIN).toISOString();
const LINK = 'https://meet.google.com/abc-defg-hij';
const SAFE_MODE = 'Live-join er av på denne huben (safe mode), så Fireflies sendes ikke inn herfra.';

const entry = (patch = {}) => ({
  slotKey: `sales:${START}`, kind: 'sales', startAt: at(0), meetLink: LINK, state: 'scheduled', attempts: 0,
  lastAttemptAt: '', verifiedAt: '', message: 'Fireflies sendes inn i Meet 3 minutter før start.', nextAttemptAt: at(-3),
  canResend: false, sessionKey: `${LINK}|${START}`, title: 'Testfirma AS · Kari Test', lastSeenAt: '', hasTranscript: false, ...patch,
});
const view = (patch, minutesFromStart, bookedMinutes = 60) => h.liveRecordingView(entry(patch), { nowMs: START + minutesFromStart * MIN, bookedMinutes });

test('only the app shell or a 404 page means a route is missing, never a proxy error page', () => {
  assert.equal(answerMeansMissingRoute({ parsed: false, status: 200, method: 'GET' }), true);
  assert.equal(answerMeansMissingRoute({ parsed: false, status: 200 }), true);
  assert.equal(answerMeansMissingRoute({ parsed: false, status: 404, method: 'POST' }), true);
  for (const status of [500, 502, 503, 504]) assert.equal(answerMeansMissingRoute({ parsed: false, status, method: 'GET' }), false, String(status));
  assert.equal(answerMeansMissingRoute({ parsed: false, status: 200, method: 'POST' }), false);
  assert.equal(answerMeansMissingRoute({ parsed: true, status: 404, method: 'GET' }), false);
  assert.match(read('app/pages/sales/emailApi.ts'), /answerMeansMissingRoute\(/);
  // One bad answer must not hide "Møter uten opptak" for the rest of the session.
  assert.doesNotMatch(read('app/pages/Admin/sections/MissingRecordingsPanel.tsx'), /setSupported/);
});

test('the health card warns about a restored backup and a live-join engine that stopped', () => {
  const card = read('app/pages/Admin/sections/FirefliesHealthCard.tsx');
  assert.match(card, /source === 'backup'/);
  assert.match(card, /Live-join har ikke kjørt/);
  assert.match(card, /LIVE_TICK_STALE_MS = 3 \* 60_000/);
  // The empty-archive state (the backfill stands still) is shown, and a file that is gone is not called unreadable.
  assert.match(card, /if \(ingestData\?\.archiveEmptySince\) \{\s*warnings\.push\(`Fireflies-arkivet er tomt, mens kundekort har opptak/);
  assert.match(card, /store\.error === 'missing' \? 'mangler' : 'kunne ikke leses'/);
});

test('a scheduled meeting only promises a send the server planned', () => {
  assert.equal(view({}, -20).label, 'Fireflies sendes inn kl. 11:57');
  assert.equal(view({}, -20).tone, 'muted');
  assert.equal(view({}, -2).label, 'Fireflies sendes inn nå');
  // Safe mode or no key: the server plans nothing and says why. No made-up time, also after the start.
  for (const minutes of [-20, 5, 25]) {
    const blocked = view({ nextAttemptAt: '', message: SAFE_MODE }, minutes);
    assert.equal(blocked.label, 'Fireflies sendes ikke inn');
    assert.equal(blocked.short, 'Sendes ikke inn');
    assert.equal(blocked.tone, 'red');
    assert.equal(blocked.blocked, true);
  }
  // Due now (the engine clears the planned time when it sends on this tick).
  assert.equal(view({ nextAttemptAt: '', canResend: true }, -2).label, 'Fireflies sendes inn nå');
  // The planned send passed and nothing happened: the engine is not running it.
  const late = view({}, 7);
  assert.equal(late.label, 'Fireflies skulle vært sendt inn kl. 11:57');
  assert.equal(late.tone, 'red');
  // Every send failed; a retry that is planned says so.
  assert.equal(view({ nextAttemptAt: '', attempts: 2, message: 'Fireflies tok ikke imot forespørselen.' }, 10).label, 'Fireflies ble ikke sendt inn');
  assert.equal(view({ attempts: 1, nextAttemptAt: at(5) }, 2).label, 'Fireflies sendes inn på nytt kl. 12:05');
});

test('the knock at the door is the amber banner, also when a bot that dropped out is sent in again', () => {
  const knock = view({ state: 'dispatched', lastAttemptAt: at(-3) }, -1);
  assert.equal(knock.knock, true);
  assert.equal(knock.label, 'Fireflies banker på – slipp inn «Fireflies.ai Notetaker» i Meet');
  // The engine stopped after that knock: Fireflies left the lobby long ago, so no banner or tab title.
  const stale = view({ state: 'dispatched', lastAttemptAt: at(-3) }, 40);
  assert.equal(stale.knock, false);
  assert.equal(stale.label, 'Fireflies er ikke bekreftet i møtet');
  const rejoin = { state: 'ended', attempts: 2, lastSeenAt: at(5), lastAttemptAt: at(8), verifiedAt: at(-2) };
  assert.equal(view(rejoin, 12).knock, true);
  assert.equal(view(rejoin, 12).label, 'Fireflies banker på igjen – slipp inn «Fireflies.ai Notetaker» i Meet');
  // The lobby wait is over: no knock, but the meeting still runs, so it is not "ferdig".
  assert.equal(view(rejoin, 21).knock, false);
  assert.equal(view(rejoin, 21).label, 'Fireflies gikk ut av møtet');
  assert.equal(view(rejoin, 21).tone, 'amber');
  // A bot that left at its own end, after the booked end.
  const ended = { state: 'ended', attempts: 1, lastAttemptAt: at(-3), lastSeenAt: at(58) };
  assert.equal(view(ended, 70).label, 'Møtet er ferdig – transkriptet kommer');
  assert.equal(view(ended, 70).knock, false);
  // A workshop is booked for 30 minutes.
  assert.equal(view({ ...ended, kind: 'workshop', lastSeenAt: at(20) }, 40, 30).label, 'Møtet er ferdig – transkriptet kommer');
  assert.equal(h.liveRecordingBookedMinutes({ kind: 'workshop' }), 30);
  assert.equal(h.liveRecordingBookedMinutes({ kind: 'sales' }, { meetingDurationMinutes: 45 }), 45);
  assert.equal(h.liveRecordingBookedMinutes({ kind: 'action' }), 60);
});

test('a transcript with talk is the answer, whatever was marked before', () => {
  for (const state of ['declined', 'missing', 'empty', 'not-admitted', 'ended']) {
    const ready = view({ state, hasTranscript: true }, 90);
    assert.equal(ready.label, 'Opptaket er klart', state);
    assert.equal(ready.ready, true, state);
  }
  assert.equal(view({ state: 'declined' }, 90).label, 'Markert uten opptak');
  assert.equal(view({ state: 'missing' }, 200).tone, 'red');
  assert.equal(view({ state: 'recording', lastSeenAt: at(10) }, 11).label, 'Fireflies tar opp');
});

test('knocks are found across clients, and a knock sorts first on its card', () => {
  const now = START - MIN;
  const a = { id: 'a', businessName: 'Testfirma AS', meetingDurationMinutes: 60, liveRecordings: [entry({ state: 'dispatched', lastAttemptAt: at(-3) })] };
  const b = { id: 'b', businessName: 'Prøvebedrift AS', liveRecordings: [entry({ slotKey: 'workshop:1', kind: 'workshop' })] };
  const knocks = h.knockingMeetings([a, b], now);
  assert.deepEqual(knocks.map((item) => item.client.id), ['a']);
  const card = { liveRecordings: [
    entry({ slotKey: 'x', state: 'recording', startAt: at(-60) }),
    entry({ slotKey: 'y', nextAttemptAt: '', message: SAFE_MODE }),
    entry({ slotKey: 'z', state: 'dispatched', lastAttemptAt: at(-3) }),
  ] };
  assert.deepEqual(h.liveRecordingsByUrgency(card, now).map((item) => item.slotKey), ['z', 'y', 'x']);
});

test('the 30-second refresh starts before any booked online slot gets its first entry', () => {
  const base = { id: 'c1', meetingMode: 'online', agreedTime: false, meetingAt: '', liveRecordings: [], meetings: [], nextActions: [] };
  const now = START - 20 * MIN;
  const workshop = { ...base, workshopAction: { name: 'Workshop', format: 'mote', dueAt: at(0), meetLink: LINK, calendarEventId: 'e1' } };
  assert.equal(h.clientNeedsLiveRefresh(workshop, now), true);
  assert.equal(h.clientNeedsLiveRefresh(workshop, START - 40 * MIN), false);
  assert.equal(h.clientNeedsLiveRefresh({ ...workshop, workshopAction: { ...workshop.workshopAction, meetLink: '' } }, now), false);
  assert.equal(h.clientNeedsLiveRefresh({ ...workshop, workshopAction: { ...workshop.workshopAction, format: 'sms' } }, now), false);
  const iteration = { ...base, workshop: { iterationMeeting: { format: 'mote', dueAt: at(0), meetLink: LINK, sentAt: at(-600) } } };
  assert.equal(h.clientNeedsLiveRefresh(iteration, now), true);
  const action = { ...base, nextActions: [{ id: 'a1', name: 'Oppfølging', format: 'mote', goalKey: 'offerSent', dueAt: at(0), meetLink: LINK, addToCalendar: true, calendarEventId: 'e2' }] };
  assert.deepEqual(h.bookedOnlineSlotStarts(action), [START]);
  assert.equal(h.clientNeedsLiveRefresh(action, now), true);
  const sales = { ...base, agreedTime: true, meetingAt: at(0) };
  assert.equal(h.clientNeedsLiveRefresh(sales, now), true);
  assert.equal(h.clientNeedsLiveRefresh({ ...sales, meetingMode: 'in-person' }, now), false);
  // Once the slot is listed, only its own state decides.
  assert.equal(h.clientNeedsLiveRefresh({ ...sales, liveRecordings: [entry({ state: 'declined' })] }, now), false);
  assert.equal(h.clientNeedsLiveRefresh({ ...sales, liveRecordings: [entry()] }, now), true);
  // A finished sales entry does not hide a workshop that starts soon.
  const both = { ...workshop, liveRecordings: [entry({ startAt: at(-120), state: 'missing' })] };
  assert.equal(h.clientNeedsLiveRefresh(both, now), true);
});

test('the sales slot never takes an earlier booking for a meeting still ahead', () => {
  const old = { meetingId: `live:c1:${START - 7 * 24 * 60 * MIN}`, slotKey: `sales:${START - 7 * 24 * 60 * MIN}`, startedAt: at(-7 * 24 * 60), recording: { state: 'missing', message: 'Ingen Fireflies-opptak etter møtet.' } };
  const rebooked = { id: 'c1', meetingMode: 'online', agreedTime: true, meetingAt: at(0), meetings: [old], liveRecordings: [] };
  const before = START - 24 * 60 * MIN;
  assert.equal(h.salesSlotRecording(rebooked, before), null);
  assert.equal(h.salesRecordingSummary(rebooked, { nowMs: before, hasMeetLink: true }).text, 'Sendes inn i Meet 3 minutter før start');
  // After that meeting: its own placeholder, else the newest one.
  const own = { meetingId: `live:c1:${START}`, slotKey: `sales:${START}`, startedAt: at(0), recording: { state: 'not-admitted', message: 'x' } };
  assert.equal(h.salesSlotRecording({ ...rebooked, meetings: [old, own] }, START + 200 * MIN).state, 'not-admitted');
  assert.equal(h.salesSlotRecording(rebooked, START + 200 * MIN).state, 'missing');
  // A late recording linked to that placeholder: the recording is the answer.
  const real = { meetingId: 'REC1', title: 'Salgsmøte', hasTranscript: true, purpose: 'sales', slotKey: `sales:${START}` };
  const found = { ...rebooked, meetings: [{ ...own, recording: { state: 'declined' } }, real] };
  assert.equal(h.salesSlotRecording(found, START + 200 * MIN), null);
  assert.equal(h.salesRecordingSummary(found, { nowMs: START + 200 * MIN }).text, 'Opptaket er koblet til kunden');
  // A blocked live entry reads the same on the Kalender line, with the server's reason.
  const live = { ...rebooked, liveRecordings: [entry({ nextAttemptAt: '', message: SAFE_MODE })] };
  const summary = h.salesRecordingSummary(live, { nowMs: START - 10 * MIN });
  assert.equal(summary.text, 'Fireflies sendes ikke inn');
  assert.equal(summary.tone, 'red');
  assert.equal(summary.detail, SAFE_MODE);
});

test('a background read never wins over a save, and a compact client keeps the card', () => {
  assert.equal(h.freshClientIsStale({ updatedAt: '2026-10-23T10:00:05.000Z' }, { updatedAt: '2026-10-23T10:00:01.000Z' }), true);
  assert.equal(h.freshClientIsStale({ updatedAt: '2026-10-23T10:00:05.000Z' }, { updatedAt: '2026-10-23T10:00:05.000Z' }), false);
  assert.equal(h.freshClientIsStale({ updatedAt: '' }, { updatedAt: '2026-10-23T10:00:01.000Z' }), false);
  const card = { id: 'c1', businessName: 'Testfirma AS', notes: 'ny', progression: { meetingHeld: true }, calendar: {}, nextActions: [], offerStatus: 'draft', liveRecordings: [entry()] };
  const compact = h.mergeFreshClient(card, { id: 'c1', businessName: 'Testfirma AS', meetings: [{ meetingId: 'R' }] });
  assert.equal(compact.notes, 'ny');
  assert.deepEqual(compact.progression, { meetingHeld: true });
  assert.deepEqual(compact.meetings, [{ meetingId: 'R' }]);
  const full = h.mergeFreshClient(card, { id: 'c1', progression: {}, calendar: {}, nextActions: [] });
  assert.equal(full.notes, undefined);
  assert.equal(full.offerStatus, 'draft');
  assert.equal(full.liveRecordings.length, 1);
});

test('live-join answers and the offer meeting state', () => {
  const now = START;
  assert.equal(h.liveJoinAnswerText({ message: 'Vent.', nextAllowedAt: at(5) }, now), 'Vent. Tidligst kl. 12:05.');
  assert.equal(h.liveJoinAnswerText({ message: 'Nå.', nextAllowedAt: new Date(now + 10_000).toISOString() }, now), 'Nå.');
  assert.equal(h.offerMeetingRecording({ pendingTranscript: true }).waiting, true);
  assert.equal(h.offerMeetingRecording({ recordingState: 'recording', pendingTranscript: true }).inMeeting, true);
  assert.equal(h.offerMeetingRecording({ recordingState: 'missing' }).noRecording, true);
  assert.equal(h.offerMeetingRecording({ recordingState: 'missing', pendingTranscript: true }).waiting, false);
});

test('the knock reaches the rep on every sales screen, and hidden boards do not poll', () => {
  const sales = read('app/pages/Admin/sections/SalesClientsSection.tsx');
  const headerAt = sales.indexOf('<header ref={headerShellRef}');
  const header = sales.slice(headerAt, sales.indexOf('</header>', headerAt));
  assert.match(header, /<FirefliesKnockStrip/);
  const overlay = sales.slice(sales.indexOf('data-sales-client-overlay'));
  assert.match(overlay, /data-flow-live-recording[\s\S]*<FirefliesLiveStatus client=\{flowClient\}/);
  assert.match(sales, /enabled: active && \(isSalesAdmin/);
  assert.match(sales, /generation: \(\) => salesListGenRef\.current/);
  assert.match(sales, /useKnockTitle\(active &&/);
  const board = read('app/pages/Admin/sections/AdminBoardSection.tsx');
  assert.match(board, /enabled: active,/);
  assert.match(board, /<FirefliesKnockStrip/);
  assert.match(read('app/pages/Admin/sections/ManageClientsSection.tsx'), /<AdminBoardSection active=\{view === 'admin'\} \/>/);
  // A rep in the Meet tab learns about the knock from the tab title, so the refresh keeps going there.
  assert.doesNotMatch(read('app/pages/Admin/sections/useLiveRecordingRefresh.ts'), /visibilityState/);
});

test('meeting rows: superseded placeholders, duplicates and empty recordings', () => {
  const placeholder = { meetingId: 'live:c1:1', slotKey: 'workshop:1', recording: { state: 'ended', ffMeetingId: 'REC1' } };
  const real = { meetingId: 'REC1', hasTranscript: true };
  const dup = { meetingId: 'REC2', hasTranscript: false, duplicateOf: 'REC1' };
  const other = { meetingId: 'live:c1:2', slotKey: 'iteration:2', recording: { state: 'missing' } };
  assert.equal(h.placeholderIsSuperseded(placeholder, [placeholder, real]), true);
  assert.equal(h.placeholderIsSuperseded(placeholder, [placeholder, { ...real, hasTranscript: false }]), false);
  assert.equal(h.placeholderIsSuperseded(other, [other, real]), false);
  assert.equal(h.placeholderIsSuperseded({ meetingId: 'live:c1:3', slotKey: 'sales:3' }, [{ meetingId: 'R3', slotKey: 'sales:3', hasTranscript: true }]), true);
  assert.deepEqual(h.visibleMeetingRows([placeholder, real, dup, other]).map((row) => row.meetingId), ['REC1', 'live:c1:2']);
  assert.deepEqual(h.visibleMeetingRows([placeholder, real, dup, other], { showDuplicates: true }).map((row) => row.meetingId), ['REC1', 'REC2', 'live:c1:2']);
  const silent = { meetingId: 'REC9', hasTranscript: false };
  const judged = { meetingId: 'live:c1:9', recording: { state: 'empty', ffMeetingId: 'REC9' } };
  assert.equal(h.realRowWaitingNote(silent, [silent, judged]), 'tomt opptak');
  assert.equal(h.realRowWaitingNote(silent, [silent]), 'venter på transkript');
  assert.equal(h.realRowWaitingNote(real, [real]), '');
});

test('the hub\'s own words on a row win: "tomt opptak", "venter på transkript", or neither; a "hallo?" never hides a placeholder', () => {
  // Card rows (presentClientMeetings) carry emptyFinal and pendingTranscript on every real recording.
  const emptyRow = { meetingId: 'REC20', placeholder: false, duplicateOf: '', hasTranscript: false, emptyFinal: true, pendingTranscript: false };
  const coming = { ...emptyRow, meetingId: 'REC21', emptyFinal: false, pendingTranscript: true };
  const gaveUp = { ...emptyRow, meetingId: 'REC22', emptyFinal: false, pendingTranscript: false };
  assert.equal(h.realRowWaitingNote(emptyRow, [emptyRow]), 'tomt opptak', 'no placeholder needs to point at it');
  assert.equal(h.realRowWaitingNote(coming, [coming]), 'venter på transkript');
  assert.equal(h.realRowWaitingNote(gaveUp, [gaveUp]), 'ingen transkript', 'never "on its way" for ever');
  // Every screen that lists a real recording without text asks the same helper.
  for (const file of [
    'app/pages/Admin/sections/ClientActivityLogCover.tsx',
    'app/pages/Admin/sections/ClientNotesFeed.tsx',
    'app/pages/Admin/sections/ClientRecordingsPanel.tsx',
    'app/pages/sales/SalesOfferComposer.tsx',
  ]) assert.match(read(file), /realRowWaitingNote\(/, file);
  assert.match(read('app/pages/sales/SalesOfferComposer.tsx'), /meeting\.emptyFinal\s*\? ' · tomt opptak'/);

  // A placeholder the hub still lists is not covered, whatever a fragment on its slot says (the hub's rule
  // needs talk that is not live captions and more than a few sentences).
  const presented = { meetingId: 'live:c1:20', placeholder: true, slotKey: 'sales:20', recording: { state: 'ended' } };
  const hello = { meetingId: 'REC23', placeholder: false, duplicateOf: '', slotKey: 'sales:20', hasTranscript: true, sentenceCount: 2 };
  assert.equal(h.placeholderIsSuperseded(presented, [presented, hello]), false);
  assert.deepEqual(h.visibleMeetingRows([presented, hello]).map((row) => row.meetingId), ['live:c1:20', 'REC23']);
  // Rows from an older hub are judged here by the same bar.
  const raw = { meetingId: 'live:c1:21', slotKey: 'sales:21', recording: { state: 'ended' } };
  const fragment = { meetingId: 'REC24', slotKey: 'sales:21', hasTranscript: true, sentenceCount: 2 };
  const captions = { meetingId: 'REC25', slotKey: 'sales:21', hasTranscript: true, partial: true, sentenceCount: 40 };
  const meeting = { meetingId: 'REC26', slotKey: 'sales:21', hasTranscript: true, sentenceCount: 40 };
  assert.equal(h.placeholderIsSuperseded(raw, [raw, fragment, captions]), false);
  assert.equal(h.placeholderIsSuperseded(raw, [raw, meeting]), true);
});

test('Tilbud and Tilbudsgjennomgang hide copies of a meeting by the hub\'s duplicateOf', () => {
  const composer = read('app/pages/sales/SalesOfferComposer.tsx');
  assert.match(composer, /const pickerShown = pickerMeetings\.filter\(\(entry\) => !entry\.duplicateOf \|\| entry\.selected \|\| showPickerDuplicates\);/);
  assert.match(composer, /pickerShown\.filter\(\(entry\) => entry\.hasTranscript && !isPlaceholderEntry\(entry\)\)/);
  assert.match(composer, /pickerShown\.filter\(\(entry\) => !entry\.hasTranscript && !isPlaceholderEntry\(entry\)\)/);
  assert.match(composer, /Vis duplikater \(\$\{pickerDuplicateCount\}\)/);
  const review = read('app/pages/Admin/sections/OfferReviewSection.tsx');
  assert.match(review, /visibleMeetingRows<OfferMeetingRef>\(detail\.client\.meetings, \{ showDuplicates: showDuplicateMeetings \}\)/);
  assert.match(review, /filter\(\(ref\) => !isPlaceholderRow\(ref\) && !isDuplicateRow\(ref\)\)\.length/);
  // The rows there are the card's (server.js compactOfferClient), so they carry duplicateOf.
  const server = read('server.js');
  const compact = server.slice(server.indexOf('function compactOfferClient('), server.indexOf('function presentOffer('));
  assert.match(compact, /meetings: presentClientMeetings\(client, null, \{ media: false \}\)\.filter\(\(row\) => !row\.placeholder\),/);
});

test('recording buttons keep unsaved offer edits, Tilbud reads the card\'s fresher rows, and admins get the buttons', () => {
  const review = read('app/pages/Admin/sections/OfferReviewSection.tsx');
  const meetings = review.slice(review.indexOf("detailTab === 'meetings'"));
  assert.match(meetings, /reloadDetailMeetings\(offer\.id\)/);
  assert.doesNotMatch(meetings, /onDone=\{\(\) => void loadDetail|onClient=\{\(\) => void loadDetail/);
  assert.match(review, /visibleMeetingRows<OfferMeetingRef>/);
  const sales = read('app/pages/Admin/sections/SalesClientsSection.tsx');
  assert.match(sales, /liveClient=\{flowClient\}/);
  assert.match(read('app/pages/Admin/sections/AdminBoardSection.tsx'), /<ClientRecordingsPanel client=\{client\}/);
  // Picking the type that is already shown still saves it (the select sits on a hidden entry).
  const controls = read('app/pages/Admin/sections/MeetingRecordingControls.tsx');
  assert.match(controls, /value=\{SHOWN_PURPOSE\}/);
  assert.match(controls, /<option value=\{SHOWN_PURPOSE\} hidden>/);
});
