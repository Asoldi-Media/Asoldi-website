// Personal-data erase across what clients share: a portal user with two businesses (one signed), a
// recording on two cards, a phone number on two cards, boot contact corrections and live-join
// sessions. Also: an erased recording is never stored again from Fireflies (list page, fetch, webhook,
// hydration), a calendar event the erase could not delete is named in the result and the audit, and the
// retention purge on a fixed clock purges a declined lead's archive after 12 months and keeps a signed
// client's. Synthetic clients only (example.com addresses, test numbers), on a temp data dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-personal-data-erase-'));
process.env.APP_DATA_DIR = DATA_DIR;
delete process.env.DATA_DIR;

const DAY = 86_400_000;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

function put(rel, value) {
  const path = join(DATA_DIR, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  return path;
}

function readJson(rel) {
  return JSON.parse(readFileSync(join(DATA_DIR, rel), 'utf8'));
}

const media = (name) => `/api/client/client-media/u-owner/${name}`;

const LEAD = {
  id: 'pe-lead',
  product: 'asoldi',
  businessName: 'Testbakeriet AS',
  contactPerson: 'Kari Testesen',
  contactEmail: 'kari@example.com',
  contactPhone: '+4790000021',
  portalUserId: 'u-owner',
  portalBusinessId: 'b-lead',
  status: 'active',
  createdAt: iso(NOW - 10 * DAY),
  calendar: { eventId: 'evt-pe-1', calendarId: 'primary', accountKey: 'admin' },
  myphoner: { leadId: 'lead-pe-1', latestCallId: 'call-pe-1' },
  meetings: [
    { meetingId: 'ff-pe-1', title: 'Salgsmøte', startedAt: iso(NOW - 5 * DAY), linkedBy: 'meet-link', purpose: 'sales' },
    { meetingId: 'ff-pe-shared', title: 'Felles møte', startedAt: iso(NOW - 4 * DAY), linkedBy: 'admin:test', purpose: 'sales' },
  ],
};
// The same portal user owns a second business with its own card, signed.
const SIGNED = {
  id: 'pe-signed',
  product: 'asoldi',
  businessName: 'Testfrisøren AS',
  contactPerson: 'Ola Testmann',
  contactEmail: 'ola@example.com',
  contactPhone: '+4790000022',
  portalUserId: 'u-owner',
  portalBusinessId: 'b-signed',
  status: 'active',
  createdAt: iso(NOW - 40 * DAY),
  progression: { meetingHeld: true, offerSent: true, contractSigned: true },
  contractSignedAt: iso(NOW - 20 * DAY),
  meetings: [{ meetingId: 'ff-pe-shared', title: 'Felles møte', startedAt: iso(NOW - 4 * DAY), linkedBy: 'admin:test', purpose: 'sales' }],
};
// Another card with the lead's phone number (a shared switchboard).
const OTHER = { id: 'pe-other', product: 'asoldi', businessName: 'Annen Kunde AS', contactEmail: 'annen@example.com', contactPhone: '+47 900 00 021', status: 'active', createdAt: iso(NOW - 3 * DAY) };

put('sales-clients.json', [LEAD, SIGNED, OTHER]);
put('client-portal-profiles.json', [
  {
    userId: 'u-owner',
    ownerUserId: 'u-owner',
    businessId: 'b-lead',
    businessName: 'Testbakeriet AS',
    email: 'eier@example.com',
    clientDataBank: { media: { galleryImages: [media('lead-photo.png')] }, brandIdentity: { logos: { normal: media('shared-logo.png') } } },
  },
  {
    userId: 'u-owner',
    ownerUserId: 'u-owner',
    businessId: 'b-signed',
    businessName: 'Testfrisøren AS',
    email: 'eier@example.com',
    clientDataBank: { brandIdentity: { logos: { normal: media('signed-logo.png'), favicon: media('shared-logo.png') } } },
  },
]);
for (const name of ['lead-photo.png', 'signed-logo.png', 'shared-logo.png', 'orphan.png']) put(`client-uploads/u-owner/${name}`, `bytes:${name}`);

put('fireflies-meetings.json', {
  'ff-pe-1': { meetingId: 'ff-pe-1', title: 'Salgsmøte', startedAt: iso(NOW - 5 * DAY), transcript: 'Kari: Hei.', at: iso(NOW), firstSeenAt: iso(NOW), final: true, match: { clientId: 'pe-lead' } },
  'ff-pe-shared': { meetingId: 'ff-pe-shared', title: 'Felles møte', startedAt: iso(NOW - 4 * DAY), transcript: 'Ola: Hei.', at: iso(NOW), firstSeenAt: iso(NOW), final: true, match: { clientId: 'pe-signed' } },
});
put('fireflies-media/ff-pe-1/audio.mp3', 'mp3');

put('myphoner-integration.json', {
  webhooks: {},
  recordingsByLeadId: { 'lead-pe-1': { leadId: 'lead-pe-1', callId: 'call-pe-1', recordingUrl: '/myphoner-recordings/lead.wav' } },
  recordingsByCallId: { 'call-pe-1': { leadId: 'lead-pe-1', callId: 'call-pe-1', recordingUrl: '/myphoner-recordings/lead.wav' } },
  recordingsByPhoneDigits: { 4790000021: { destinationDigits: '4790000021', callId: 'call-sw-1', recordingUrl: '/myphoner-audio/switchboard.mp3' } },
  pendingRecordingsByCallId: {},
});
put('myphoner-recordings/lead.wav', 'wav');
put('myphoner-audio/switchboard.mp3', 'mp3');

const CORRECTIONS = {
  note: 'kept as it is',
  corrections: [
    { businessName: 'Testbakeriet', contactPerson: 'Kari Testesen', contactEmail: 'kari@example.com', createIfMissing: true },
    { businessName: 'Annen Kunde', forcePhone: true, contactPhone: '+4790000099' },
    { businessName: 'Test', notes: 'matches both test businesses' },
    { businessName: 'Helt Ny Kunde AS', contactEmail: 'ny@example.com', createIfMissing: true },
  ],
};
put('sales-contact-corrections.json', CORRECTIONS);

const START = iso(NOW + 2 * DAY);
put('fireflies-live-sessions.json', {
  version: 1,
  sessions: {
    'room-a': { key: 'room-a', meetLink: 'https://meet.google.com/aaa-bbbb-ccc', startAt: START, title: 'Testbakeriet AS · Kari Testesen', slots: [{ clientId: 'pe-lead', kind: 'sales', slotKey: 'sales' }] },
    'room-b': {
      key: 'room-b',
      meetLink: 'https://meet.google.com/ddd-eeee-fff',
      startAt: START,
      title: 'Testbakeriet AS · Kari Testesen',
      slots: [{ clientId: 'pe-lead', kind: 'sales', slotKey: 'sales' }, { clientId: 'pe-signed', kind: 'workshop', slotKey: 'workshop' }],
    },
    'room-c': { key: 'room-c', meetLink: 'https://meet.google.com/ggg-hhhh-iii', startAt: START, title: 'Testfrisøren AS · Ola Testmann', slots: [{ clientId: 'pe-signed', kind: 'sales', slotKey: 'sales' }] },
  },
  limiter: { calls: [] },
});

const personalData = await import('../lib/personal-data.js');
const webhook = await import('../lib/fireflies-webhook.js');
const ingest = await import('../lib/fireflies-ingest.js');
const erased = await import('../lib/fireflies-erased.js');
const sales = await import('../data/sales.js');
const corrections = await import('../data/sales-contact-corrections.js');

function rowOf(result, id) {
  return result.stores.find((row) => row.id === id);
}

test('a portal user with several businesses never resolves to a profile by user id alone', () => {
  const profiles = readJson('client-portal-profiles.json');
  const clients = [LEAD, SIGNED, OTHER];
  assert.equal(personalData.ownPortalProfile(LEAD, profiles, { clients }).businessId, 'b-lead');
  assert.equal(personalData.ownPortalProfile(SIGNED, profiles, { clients }).businessId, 'b-signed');
  const userOnly = { id: 'pe-x', portalUserId: 'u-owner' };
  assert.equal(personalData.ownPortalProfile(userOnly, profiles, { clients }), null, 'two businesses: no fallback');
  const single = [{ userId: 'u-single', ownerUserId: 'u-single', businessId: 'u-single' }];
  assert.equal(personalData.ownPortalProfile({ id: 'pe-y', portalUserId: 'u-single' }, single, { clients: [] }).businessId, 'u-single', 'one business: the fallback works');
  assert.equal(personalData.ownPortalProfile({ id: 'pe-y', portalUserId: 'u-single' }, single, { clients: [{ id: 'pe-z', portalUserId: 'u-single' }] }), null, 'claimed by another card: no fallback');
});

test('the erase plan lists only the lead\'s own uploads, holds what is shared, and leaves the other business\'s files out', async () => {
  const signedBefore = await personalData.exportClient('pe-signed');
  const plan = await personalData.eraseClient('pe-lead');
  const uploads = rowOf(plan, 'client-uploads');
  assert.equal(uploads.action, 'delete');
  assert.deepEqual(uploads.files, ['client-uploads/u-owner/lead-photo.png']);
  assert.deepEqual(uploads.held, ['client-uploads/u-owner/orphan.png', 'client-uploads/u-owner/shared-logo.png']);
  assert.equal(uploads.reason, 'shared-portal-user');
  assert.equal(JSON.stringify(plan).includes('signed-logo.png'), false, 'the signed business\'s logo is not in the lead\'s plan');
  const exported = await personalData.exportClient('pe-lead');
  const portal = exported.stores.find((row) => row.id === 'client-portal');
  assert.deepEqual(portal.records.map((row) => row.businessId), ['b-lead'], 'the export holds the lead\'s own profile only');
  const signedUploads = signedBefore.stores.find((row) => row.id === 'client-uploads').files.map((file) => file.path);
  assert.deepEqual(signedUploads, ['client-uploads/u-owner/orphan.png', 'client-uploads/u-owner/shared-logo.png', 'client-uploads/u-owner/signed-logo.png']);
});

test('the erase plan holds a recording another card has, a shared dialler entry and a correction that matches another card', async () => {
  const plan = await personalData.eraseClient('pe-lead');
  const meetings = rowOf(plan, 'fireflies-meetings');
  assert.equal(meetings.action, 'delete');
  assert.deepEqual(meetings.held, ['ff-pe-shared']);
  assert.equal(meetings.reason, 'shared-recording');
  assert.ok(meetings.files.includes('fireflies-media/ff-pe-1/audio.mp3'));
  assert.ok(meetings.files.includes('privacy/erased-meetings.json'), 'the plan says the erased list is written');
  const calls = rowOf(plan, 'call-recordings');
  assert.deepEqual(calls.files.sort(), ['myphoner-integration.json', 'myphoner-recordings/lead.wav']);
  assert.deepEqual(calls.held.sort(), ['myphoner-audio/switchboard.mp3', 'myphoner-integration.json#recordingsByPhoneDigits:4790000021']);
  const fixes = rowOf(plan, 'sales-contact-corrections');
  assert.equal(fixes.action, 'delete');
  assert.deepEqual(fixes.files, ['sales-contact-corrections.json', 'sales-contact-corrections.json[0]']);
  assert.deepEqual(fixes.held, ['sales-contact-corrections.json[2]']);
  assert.equal(fixes.reason, 'boot-correction');
  const live = rowOf(plan, 'fireflies-live-sessions');
  assert.equal(live.action, 'delete');
  assert.equal(live.records, 2);
  assert.deepEqual(rowOf(plan, 'calendar-event').ids, { eventId: 'evt-pe-1', calendarId: 'primary' });
  assert.deepEqual(readJson('sales-contact-corrections.json'), CORRECTIONS, 'a plan writes nothing');
  assert.equal(existsSync(join(DATA_DIR, 'privacy', 'erased-meetings.json')), false, 'a plan writes no erased list');
});

test('the export hands over the client\'s own contact corrections in full and only the matched fields of a shared one', async () => {
  const exported = await personalData.exportClient('pe-lead');
  const fixes = exported.stores.find((row) => row.id === 'sales-contact-corrections');
  assert.deepEqual(fixes.records, [
    { index: 0, ...CORRECTIONS.corrections[0] },
    { index: 2, shared: true, matched: { businessName: 'Test' } },
  ]);
  assert.equal(JSON.stringify(fixes.records).includes('matches both test businesses'), false, 'the shared entry\'s notes stay out');
  assert.match(fixes.note, /another client card/);
  const signed = (await personalData.exportClient('pe-signed')).stores.find((row) => row.id === 'sales-contact-corrections');
  assert.deepEqual(signed.records, [{ index: 2, shared: true, matched: { businessName: 'Test' } }]);
});

test('the erase keeps the other business\'s files, cards, recordings, cache entries, corrections and sessions', async () => {
  const signedBefore = (await personalData.exportClient('pe-signed')).stores.find((row) => row.id === 'client-uploads');
  // Safe mode (or a calendar error): the event stays, and the result and the audit name it.
  const result = await personalData.eraseClient('pe-lead', { dryRun: false, by: 'superadmin', deleteCalendarEvent: async () => ({ deleted: false, safeMode: true }) });
  assert.equal(result.erased, true);

  assert.equal(existsSync(join(DATA_DIR, 'client-uploads/u-owner/lead-photo.png')), false, 'the lead\'s own upload is gone');
  for (const name of ['signed-logo.png', 'shared-logo.png', 'orphan.png']) {
    assert.ok(existsSync(join(DATA_DIR, 'client-uploads/u-owner', name)), `${name} stays`);
  }
  const signedAfter = (await personalData.exportClient('pe-signed')).stores.find((row) => row.id === 'client-uploads');
  assert.deepEqual(signedAfter, signedBefore, 'the signed client\'s uploads and their export are unchanged');

  const meetings = readJson('fireflies-meetings.json');
  assert.equal(meetings['ff-pe-1'], undefined);
  assert.ok(meetings['ff-pe-shared'], 'the recording the signed card also has stays');
  assert.equal(existsSync(join(DATA_DIR, 'fireflies-media/ff-pe-1')), false);
  assert.deepEqual(Object.keys(readJson('privacy/erased-meetings.json').meetings), ['ff-pe-1'], 'ids only, the erased one only');

  const dialler = readJson('myphoner-integration.json');
  assert.deepEqual(Object.keys(dialler.recordingsByLeadId), []);
  assert.deepEqual(Object.keys(dialler.recordingsByCallId), []);
  assert.deepEqual(Object.keys(dialler.recordingsByPhoneDigits), ['4790000021'], 'the entry the other card\'s number also finds stays');
  assert.equal(existsSync(join(DATA_DIR, 'myphoner-recordings/lead.wav')), false);
  assert.ok(existsSync(join(DATA_DIR, 'myphoner-audio/switchboard.mp3')));

  const fixes = readJson('sales-contact-corrections.json');
  assert.equal(fixes.note, 'kept as it is', 'the file keeps its shape');
  assert.deepEqual(fixes.corrections.map((row) => row.businessName), ['Annen Kunde', 'Test', 'Helt Ny Kunde AS']);
  // What the next boot reads: no entry that would create the erased lead again.
  const atBoot = corrections.loadSalesContactCorrections(DATA_DIR);
  const remaining = sales.getSalesClients();
  for (const entry of atBoot.filter((row) => row.createIfMissing)) {
    assert.equal(personalData.correctionMatchesClient(entry, LEAD) && !remaining.some((client) => personalData.correctionMatchesClient(entry, client)), false, `${entry.businessName} would not recreate the lead`);
  }
  assert.equal(JSON.stringify(atBoot).includes('kari@example.com'), false);
  // ...and the list this running hub loaded at boot (the admin "apply contact corrections" action).
  assert.deepEqual(corrections.SALES_CONTACT_CORRECTIONS.map((row) => row.businessName), ['Annen Kunde', 'Test', 'Helt Ny Kunde AS']);

  const sessions = readJson('fireflies-live-sessions.json').sessions;
  assert.deepEqual(Object.keys(sessions).sort(), ['room-b', 'room-c']);
  assert.deepEqual(sessions['room-b'].slots.map((slot) => slot.clientId), ['pe-signed']);
  assert.equal(sessions['room-b'].title, '', 'no title naming the erased client');
  assert.equal(sessions['room-c'].title, 'Testfrisøren AS · Ola Testmann');

  const calendar = rowOf(result, 'calendar-event');
  assert.equal(calendar.action, 'retain');
  assert.equal(calendar.reason, 'safe-mode');
  assert.deepEqual(calendar.ids, { eventId: 'evt-pe-1', calendarId: 'primary' });
  const month = new Date().toISOString().slice(0, 7);
  const audit = readFileSync(join(DATA_DIR, 'delivery-audit', `${month}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const entry = audit.find((row) => row.kind === 'privacy-erase' && row.clientId === 'pe-lead');
  assert.deepEqual(entry.retained, ['calendar-event primary evt-pe-1'], 'the audit names the event to remove by hand');
  assert.doesNotMatch(JSON.stringify(entry), /example\.com|Testbakeriet|Kari/);
  assert.ok(sales.getSalesClientById('pe-signed') && sales.getSalesClientById('pe-other'));
});

test('an erased recording is not stored again by a list page, a fetch, a media or link write, a webhook or the hydration plan', async () => {
  const listed = webhook.upsertListedFirefliesMeetings([
    { meetingId: 'ff-pe-1', title: 'Salgsmøte', startedAt: iso(NOW - 5 * DAY), listedSummaryStatus: 'processed' },
    { meetingId: 'ff-pe-new', title: 'Nytt møte', startedAt: iso(NOW), listedSummaryStatus: 'processing' },
  ]);
  assert.deepEqual(listed.map((row) => [row.id, row.isNew, row.changed]), [['ff-pe-1', false, false], ['ff-pe-new', true, true]], 'control: a new id is stored');
  assert.equal(webhook.storeFetchedFirefliesMeeting({ meetingId: 'ff-pe-1', transcript: 'Kari: Hei.' }), null);
  assert.equal(webhook.storeFirefliesMeeting({ meetingId: 'ff-pe-1', transcript: 'Kari: Hei.' }), null);
  assert.equal(webhook.upsertStoredFirefliesMeetings([{ meetingId: 'ff-pe-1', transcript: 'x' }]).length, 0);
  assert.equal(webhook.updateStoredFirefliesMeeting('ff-pe-1', { media: { audio: { state: 'saved' } } }), null);
  assert.equal(webhook.noteFirefliesFetchFailure('ff-pe-1', 'timeout'), null);
  assert.equal(webhook.setStoredFirefliesClientLink('ff-pe-1', { match: { clientId: 'pe-signed' } }, { create: true }), null);

  let fetches = 0;
  let sends = 0;
  const deps = { fetchTranscript: async () => { fetches += 1; return { id: 'ff-pe-1', title: 'x', sentences: [] }; }, sendEmail: async () => { sends += 1; } };
  const notified = await webhook.notifyFirefliesRecording({ meeting_id: 'ff-pe-1', event: 'Transcription completed' }, { apiKey: 'test-key', notifyEmail: 'varsel@example.com' }, deps);
  assert.equal(notified.reason, 'erased');
  await assert.rejects(() => webhook.refreshFirefliesMeeting('ff-pe-1', { apiKey: 'test-key' }, deps), /slettet/);
  assert.equal(fetches, 0, 'nothing is fetched from Fireflies');
  assert.equal(sends, 0, 'nothing is e-mailed');

  const plan = ingest.planFirefliesHydration({
    clientRows: [{ clientId: 'pe-signed', row: { meetingId: 'ff-pe-1' } }, { clientId: 'pe-signed', row: { meetingId: 'ff-pe-unknown' } }],
    readStored: () => null,
  });
  assert.deepEqual(plan.fetch, ['ff-pe-unknown'], 'control: an unknown id on a card is fetched, the erased one is not');

  const stored = readJson('fireflies-meetings.json');
  assert.equal(stored['ff-pe-1'], undefined, 'not stored again');
  assert.ok(stored['ff-pe-new']);
  assert.equal(existsSync(join(DATA_DIR, 'fireflies-media/ff-pe-1')), false);
});

test('the erased list keeps ids for 400 days, then the purge drops them', () => {
  const later = new Date(Date.now() + 401 * DAY);
  const report = erased.purgeErasedFirefliesMeetings({ dryRun: true, now: later });
  assert.deepEqual(report.items.map((row) => row.meetingId), ['ff-pe-1']);
  assert.ok(erased.isErasedFirefliesMeeting('ff-pe-1'), 'a dry run drops nothing');
  erased.purgeErasedFirefliesMeetings({ dryRun: false, now: later });
  assert.equal(erased.isErasedFirefliesMeeting('ff-pe-1'), false);
  assert.equal(erased.purgeErasedFirefliesMeetings({ dryRun: true, now: new Date() }).items.length, 0);
});

test('the purge on a fixed clock: a declined lead\'s archive goes 12 months after the decline, a signed client\'s stays', async () => {
  const settingsStore = await import('../data/automation-settings.js');
  const retention = await import('../lib/delivery-retention.js');
  await import('../lib/transcript-archive.js');
  const CLOCK = new Date('2028-06-01T12:00:00.000Z');
  const months = (n) => iso(CLOCK.getTime() - n * 30.4375 * DAY);
  const archived = (clientId) => {
    const sha = clientId.padEnd(64, '0').replace(/[^a-f0-9]/g, 'a').slice(0, 64);
    put(`transcript-archive/${clientId}/${sha}.json`, { meetingId: `ff-${clientId}`, sha256: sha, transcript: 'A: b', archivedAt: months(14), retainUntil: '' });
    return join(DATA_DIR, 'transcript-archive', clientId);
  };
  const clients = readJson('sales-clients.json');
  clients.push(
    { id: 'pe-declined-13', product: 'asoldi', businessName: 'Avslag Tretten AS', status: 'not-sold', createdAt: months(20), archive: { archivedAt: months(13), reason: 'Ikke interessert' } },
    { id: 'pe-declined-11', product: 'asoldi', businessName: 'Avslag Elleve AS', status: 'not-sold', createdAt: months(20), archive: { archivedAt: months(11), reason: 'Ikke interessert' } },
  );
  for (const client of clients) if (client.id === 'pe-signed') client.createdAt = months(30);
  writeFileSync(join(DATA_DIR, 'sales-clients.json'), JSON.stringify(clients, null, 2));
  const gone = archived('pe-declined-13');
  const kept = archived('pe-declined-11');
  const signed = archived('pe-signed');
  assert.equal(personalData.clientRetention(sales.getSalesClientById('pe-declined-13')).basis, 'not-sold');

  assert.equal(settingsStore.saveAutomationSettings({ privacy: { purge: { enabled: true, mode: 'auto' } } }).ok, true);
  const run = await retention.runRetentionPurge({ settings: settingsStore.getAutomationSettings({ fresh: true }), now: CLOCK, force: true });
  assert.equal(run.dryRun, false);
  assert.equal(existsSync(gone), false, 'declined 13 months ago: purged');
  assert.ok(existsSync(kept) && readdirSync(kept).length === 1, 'declined 11 months ago: kept');
  assert.ok(existsSync(signed) && readdirSync(signed).length === 1, 'signed, contract running: kept');
  assert.equal(settingsStore.saveAutomationSettings({ privacy: { purge: { enabled: false, mode: 'shadow' } } }).ok, true);
});
