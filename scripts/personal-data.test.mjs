// Personal-data registry: export covers every store, an erase dry run lists the files and deletes
// nothing, legal holds keep the signed contract (also on a repeated erase and in every copy), an erase
// takes the client out of every backup and snapshot copy of what it erases, the erase route answers 403
// while privacy.purge is off, an export never reads large media, and the retention purge deletes
// nothing unless privacy.purge is on in auto mode.
// Synthetic clients only (example.com addresses, test numbers), on a temp data dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-personal-data-'));
process.env.APP_DATA_DIR = DATA_DIR;
delete process.env.DATA_DIR;

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const DAY = 86_400_000;

function put(rel, value) {
  const path = join(DATA_DIR, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  return path;
}

function emailHash(email) {
  return `sha256:${createHash('sha256').update(email).digest('hex')}`;
}

const LEAD_PHONE = '+4790000001';
const LEAD = {
  id: 'pd-lead',
  product: 'asoldi',
  businessName: 'Testbakeriet AS',
  contactPerson: 'Kari Testesen',
  contactEmail: 'kari@example.com',
  contactPhone: LEAD_PHONE,
  portalUserId: 'u-lead',
  portalBusinessId: 'b-lead',
  status: 'active',
  progression: { meetingHeld: true },
  calendar: { eventId: 'evt-pd-1', calendarId: 'primary', accountKey: 'admin' },
  myphoner: { leadId: 'lead-pd-1', latestCallId: 'call-pd-1', latestRecordingUrl: '/myphoner-recordings/call-pd-1.wav' },
  meetings: [{ meetingId: 'ff-lead-1', title: 'Salgsmøte', startedAt: iso(NOW - 5 * DAY), linkedBy: 'meet-link', purpose: 'sales' }],
  ext: { mediaRights: { 'u-lead/logo.png': { confirmed: true, at: iso(NOW) } } },
};
const SIGNED = {
  id: 'pd-signed',
  product: 'asoldi',
  businessName: 'Testfrisøren AS',
  contactEmail: 'ola@example.com',
  status: 'active',
  progression: { meetingHeld: true, offerSent: true, contractSigned: true },
  contractSignedAt: iso(NOW - 20 * DAY),
};
// Another card points at a call recording the lead's dialler cache also names: that file is shared.
const OTHER = { id: 'pd-other', product: 'asoldi', businessName: 'Annen Kunde AS', contactEmail: 'other@example.com', status: 'active', myphoner: { latestRecordingUrl: '/myphoner-audio/shared.mp3' } };

put('sales-clients.json', [LEAD, SIGNED, OTHER]);
const OFFERS = [
  { id: 'offer-lead', salesClientId: 'pd-lead', status: 'draft', tierId: 'tier-1-standard', email: { subject: 'Tilbud', html: '<p>x</p>' }, products: [] },
  { id: 'offer-signed', salesClientId: 'pd-signed', status: 'sent', sentAt: iso(NOW - 25 * DAY), tierId: 'tier-1-standard', email: { subject: 'Tilbud', html: '<p>x</p>' }, products: [] },
  { id: 'offer-other', salesClientId: 'pd-other', status: 'draft', tierId: 'tier-1-standard', email: { subject: 'Tilbud', html: '<p>x</p>' }, products: [] },
];
put('sales-offers.json', OFFERS);
put('client-offers.json', [
  { id: 'portal-signed', code: 'QK74', salesClientId: 'pd-signed', acceptance: { acceptedAt: iso(NOW - 21 * DAY), email: 'ola@example.com', ip: '192.0.2.10' } },
  { id: 'portal-lead', code: 'QK75', salesClientId: 'pd-lead' },
]);
const INBOX = {
  processed: {},
  sources: {},
  baselines: {},
  items: [
    { id: 'inbox-lead-1', kind: 'client_elements', mailbox: 'inbox@example.com', salesClientId: 'pd-lead', from: 'kari@example.com', subject: 'Bilder', summary: 'Bilder fra kunden', text: 'Hei, her er bildene', status: 'staged' },
    { id: 'inbox-signed-1', kind: 'signed_contract', mailbox: 'inbox@example.com', salesClientId: 'pd-signed', from: 'ola@example.com', subject: 'Signert', summary: 'Signert kontrakt', fileName: 'kontrakt.pdf', status: 'accepted' },
  ],
};
put('inbox-bot.json', INBOX);
put('inbox-contracts/pd-signed/kontrakt.pdf', '%PDF-1.4 test');
put('inbox-bot-staging/pd-lead/123-bilde.jpg', 'jpeg-bytes');
const MEETINGS = {
  'ff-lead-1': { meetingId: 'ff-lead-1', title: 'Salgsmøte', startedAt: iso(NOW - 5 * DAY), transcript: 'Kari: Hei\nSelger: Hei', at: iso(NOW), match: { clientId: 'pd-lead', linkedBy: 'meet-link' } },
  'ff-other': { meetingId: 'ff-other', title: 'Annet', transcript: 'X: y', at: iso(NOW), match: { clientId: 'pd-other' } },
};
put('fireflies-meetings.json', MEETINGS);
put('fireflies-media/ff-lead-1/transcript.txt', 'Kari: Hei');
// Dialler: the lead's recording, a recording shared with another card, and the recording cache.
const leadRecording = { recordingUrl: '/myphoner-recordings/call-pd-1.wav', callId: 'call-pd-1', leadId: 'lead-pd-1', destinationDigits: '4790000001' };
const sharedRecording = { localRecordingUrl: '/myphoner-audio/shared.mp3', callId: 'call-pd-2', destinationDigits: '4790000001' };
const otherRecording = { recordingUrl: '/myphoner-recordings/call-x.wav', callId: 'call-x', leadId: 'lead-x', destinationDigits: '4790000009' };
const DIALLER = {
  webhooks: { listWinnerByListId: {}, accountByEvent: {} },
  recordingsByLeadId: { 'lead-pd-1': leadRecording, 'lead-x': otherRecording },
  recordingsByCallId: { 'call-pd-1': leadRecording, 'call-pd-2': sharedRecording, 'call-x': otherRecording },
  recordingsByPhoneDigits: { 4790000001: sharedRecording, 4790000009: otherRecording },
  pendingRecordingsByCallId: { 'call-pd-2': { callId: 'call-pd-2' }, 'call-x2': { callId: 'call-x2' } },
};
put('myphoner-integration.json', DIALLER);
put('myphoner-recordings/call-pd-1.wav', 'wav-bytes');
put('myphoner-recordings/call-x.wav', 'wav-bytes-other');
put('myphoner-audio/shared.mp3', 'mp3-bytes');
put('sales-site-imports/pd-lead/index.html', '<h1>Testbakeriet</h1><p>kari@example.com</p>');
put('dev-handoffs/pd-lead.zip', 'zip-bytes');
put('media/client-pd-lead/butikk.jpg', 'jpeg-library');
put('media-library.json', { items: { 'client-pd-lead/butikk.jpg': { tags: ['client:pd-lead'] }, 'site/hero.jpg': { tags: ['site'] } } });
put('transcript-archive/pd-lead/' + 'a'.repeat(64) + '.json', { meetingId: 'ff-lead-1', sha256: 'a'.repeat(64), transcript: 'Kari: Hei', archivedAt: iso(NOW), retainUntil: iso(NOW + 300 * DAY) });
put('delivery-briefs/pd-lead/v1.json', { facts: { identity: { brandName: 'Testbakeriet' } } });
put('media-manifest/pd-lead.json', { kind: 'asoldi.media-manifest/1', clientId: 'pd-lead', items: [] });
put('client-uploads/u-lead/logo.png', 'png-bytes');
put('client-portal-profiles.json', [{ userId: 'u-lead', ownerUserId: 'u-lead', businessId: 'b-lead', businessName: 'Testbakeriet AS', email: 'kari@example.com' }]);
const NEEDS = { clients: { 'pd-lead': { needs: ['Nettbutikk'] }, 'pd-other': { needs: [] } } };
put('workshop-needs.json', NEEDS);
const DEV_REQUESTS = { threads: { 'pd-lead': { salesClientId: 'pd-lead', messages: [{ text: 'Bytt logo' }] } } };
put('admin-dev-requests.json', DEV_REQUESTS);
put('admin-dev-request-files/pd-lead/f-1-skisse.png', 'png');
put('seo-ops/clients/pd-lead.json', { salesClientId: 'pd-lead', agreedKeywords: ['bakeri oslo'] });
put('delivery-audit/2026-10.jsonl', `${JSON.stringify({ at: iso(NOW), kind: 'stage', clientId: 'pd-lead', to: 'lead' })}\n`);
put('maker-access-log/2026-10.jsonl', `${JSON.stringify({ at: iso(NOW), hostId: 'mh_1', clientId: 'pd-lead', kind: 'brief', allowed: true })}\n`);
put('fireflies-link-audit/2026-10.jsonl', `${JSON.stringify({ at: iso(NOW), action: 'link', meetingId: 'ff-lead-1', clientId: 'pd-lead', by: 'meet-link' })}\n`);
put('migrations/delivery-backfill-1-dry-run.json', { stages: [{ clientId: 'pd-lead', stage: 'lead' }] });
put('email-log/messages-202610.jsonl', `${JSON.stringify({ id: 'em_1', kind: 'offer', toHash: emailHash('kari@example.com'), toMasked: 'k***@example.com', status: 'accepted', createdAt: iso(NOW) })}\n`);
const snapshotClients = JSON.stringify([LEAD, SIGNED, OTHER], null, 2);
put('snapshots/batch-2-test/sales-clients.json', snapshotClients);
put('snapshots/batch-2-test/sales-offers.json', OFFERS);
put('snapshots/batch-2-test/manifest.json', {
  kind: 'delivery-snapshot',
  id: 'batch-2-test',
  files: [
    { name: 'sales-clients.json', bytes: snapshotClients.length, sha256: 'old', records: 3 },
    { name: 'sales-offers.json', bytes: 1, sha256: 'old', records: 3 },
  ],
});
// Automatic backups of every store an erase changes, as writeDataJson and the Fireflies store name them.
const STAMP = '2026-10-01T10-00-00-000Z';
put('backups/sales-clients.json.latest.json', snapshotClients);
put(`backups/sales-offers.json.${STAMP}.json`, OFFERS);
put(`backups/fireflies-meetings.json.${STAMP}.json`, MEETINGS);
put('backups/fireflies-meetings.json.latest.json', MEETINGS);
put(`backups/inbox-bot.json.${STAMP}.json`, INBOX);
put('backups/workshop-needs.json.latest.json', NEEDS);
put(`backups/admin-dev-requests.json.${STAMP}.json`, DEV_REQUESTS);
put('backups/media-rights.json.latest.json', { businesses: { 'b-lead': { 'u-lead/logo.png': { confirmed: true, at: iso(NOW) } }, 'b-x': { 'u-x/a.jpg': { confirmed: true, at: iso(NOW) } } } });
put('backups/myphoner-integration.json.latest.json', DIALLER);
put(`backups/seo-ops__clients__pd-lead.json.${STAMP}.json`, { salesClientId: 'pd-lead', agreedKeywords: ['bakeri oslo'] });
// A copy that does not parse is never rewritten; the erase reports it.
const UNREADABLE = `backups/fireflies-meetings.json.unreadable-${STAMP}`;
put(UNREADABLE, '{"ff-lead-1": {"transcript": "Kari: Hei');
// What only the erased lead has, in any copy: transcript, e-mail text, address, needs, messages, keywords, phone.
const LEAD_MARKERS = ['Kari: Hei', 'Hei, her er bildene', 'kari@example.com', 'Nettbutikk', 'Bytt logo', 'bakeri oslo', '4790000001'];

function filesUnder(rel) {
  const root = join(DATA_DIR, rel);
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath || entry.path, entry.name).slice(DATA_DIR.length + 1).split('\\').join('/'));
}

const calendarCalls = [];
const deleteCalendarEvent = async (client) => {
  calendarCalls.push(client?.calendar?.eventId);
  return { deleted: true };
};

const personalData = await import('../lib/personal-data.js');
const settingsStore = await import('../data/automation-settings.js');
const retention = await import('../lib/delivery-retention.js');
const sales = await import('../data/sales.js');
await import('../lib/transcript-archive.js');

const FILLED = [
  'sales-clients', 'calendar-event', 'sales-offers', 'portal-offers', 'inbox-items', 'inbox-attachments',
  'fireflies-meetings', 'transcript-archive', 'delivery-briefs', 'media-manifest', 'client-uploads', 'client-portal',
  'workshop-needs', 'dev-requests', 'dev-request-files', 'seo-client', 'media-rights', 'delivery-audit',
  'maker-access-log', 'fireflies-link-audit', 'migrations', 'email-log',
  'call-recordings', 'sales-site-imports', 'dev-handoffs', 'hub-library-media',
];

test('the registry has the built-in stores, each with a retention text', async () => {
  const stores = await personalData.loadStoreModules();
  const ids = stores.map((store) => store.id);
  for (const id of [...FILLED, 'signed-contracts', 'snapshots', 'data-backups', 'hub-sites']) assert.ok(ids.includes(id), id);
  for (const store of stores) assert.ok(personalData.retentionText(store.id).length > 20, `${store.id} retention text`);
  assert.match(personalData.retentionText('transcript-archive'), /12 måneder/);
  assert.match(personalData.retentionText('transcript-archive', { lang: 'en', settings: { retention: { leadMonths: 6, afterContractMonths: 18 } } }), /6 months.*18 months/s);
  assert.throws(() => personalData.registerStore({ id: 'Bad Id', export() {}, erase() {} }), /bad id/);
});

test('the export covers every store and finds the client in each store that holds it', async () => {
  const bundle = await personalData.exportClient('pd-lead');
  const stores = await personalData.loadStoreModules();
  assert.equal(bundle.kind, 'asoldi.personal-data-export');
  assert.equal(bundle.found, true);
  assert.deepEqual(bundle.stores.map((row) => row.id).sort(), stores.map((store) => store.id).sort());
  const byId = Object.fromEntries(bundle.stores.map((row) => [row.id, row]));
  for (const id of FILLED) {
    assert.ok(byId[id].records.length + byId[id].files.length > 0, `${id} has the client's data`);
    assert.equal(byId[id].error, undefined, `${id} exported without error`);
  }
  assert.equal(byId['sales-clients'].records[0].contactEmail, 'kari@example.com');
  assert.ok(byId['fireflies-meetings'].records.every((row) => row.meetingId === 'ff-lead-1'), 'only the client\'s recordings');
  assert.equal(byId['workshop-needs'].records.length, 1);
  assert.deepEqual(byId['calendar-event'].records, [{ eventId: 'evt-pd-1', calendarId: 'primary' }]);
  assert.deepEqual(byId['call-recordings'].files.map((file) => file.path).sort(), ['myphoner-audio/shared.mp3', 'myphoner-recordings/call-pd-1.wav']);
  assert.deepEqual(byId['call-recordings'].records.map((row) => `${row.list}:${row.key}`).sort(), [
    'recordingsByCallId:call-pd-1', 'recordingsByCallId:call-pd-2', 'recordingsByLeadId:lead-pd-1', 'recordingsByPhoneDigits:4790000001',
  ]);
  assert.deepEqual(byId['hub-library-media'].files.map((file) => file.path), ['media/client-pd-lead/butikk.jpg']);
  const transcriptFile = byId['fireflies-meetings'].files.find((file) => file.path === 'fireflies-media/ff-lead-1/transcript.txt');
  assert.equal(transcriptFile.sha256, createHash('sha256').update('Kari: Hei').digest('hex'), 'small files carry their sha256');
  const text = JSON.stringify(bundle);
  assert.doesNotMatch(text, /other@example\.com|Annen Kunde|call-x|lead-x/, 'no other client in the bundle');
});

test('an export lists a large media file with its size and never reads it', async () => {
  const big = join(DATA_DIR, 'fireflies-media', 'ff-lead-1', 'video.mp4');
  const size = 512 * 1024 * 1024;
  const fd = openSync(big, 'w');
  try {
    ftruncateSync(fd, size);
  } finally {
    closeSync(fd);
  }
  try {
    global.gc?.();
    const heapBefore = process.memoryUsage().heapUsed;
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 5);
    const started = Date.now();
    const bundle = await personalData.exportClient('pd-lead');
    const plan = await personalData.eraseClient('pd-lead');
    const elapsed = Date.now() - started;
    clearInterval(timer);
    const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
    const video = bundle.stores.find((row) => row.id === 'fireflies-meetings').files.find((file) => file.path.endsWith('video.mp4'));
    assert.equal(video.bytes, size);
    assert.equal(video.sha256, '', 'not hashed: over the export limit');
    assert.equal(bundle.hashLimitBytes, personalData.EXPORT_HASH_MAX_BYTES);
    assert.ok(plan.stores.find((row) => row.id === 'fireflies-meetings').files.includes('fireflies-media/ff-lead-1/video.mp4'));
    assert.ok(elapsed < 15_000, `export and plan took ${elapsed} ms`);
    assert.ok(heapGrowth < 128 * 1024 * 1024, `heap grew ${Math.round(heapGrowth / 1048576)} MB`);
    assert.ok(ticks > 0, 'the event loop kept running');
  } finally {
    rmSync(big, { force: true });
  }
});

test('an erase dry run lists the files and deletes nothing', async () => {
  const before = readFileSync(join(DATA_DIR, 'sales-clients.json'), 'utf8');
  const copiesBefore = Object.fromEntries([...filesUnder('backups'), ...filesUnder('snapshots')].map((rel) => [rel, readFileSync(join(DATA_DIR, rel), 'utf8')]));
  const plan = await personalData.eraseClient('pd-lead', { deleteCalendarEvent });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.erased, false);
  const byId = Object.fromEntries(plan.stores.map((row) => [row.id, row]));
  assert.equal(byId['sales-clients'].action, 'delete');
  assert.ok(byId['transcript-archive'].files.some((file) => file.startsWith('transcript-archive/pd-lead/')));
  assert.ok(byId['client-uploads'].files.includes('client-uploads/u-lead/logo.png'));
  assert.equal(byId['inbox-items'].action, 'redact');
  assert.equal(byId['delivery-audit'].action, 'retain');
  assert.equal(byId['calendar-event'].action, 'delete');
  assert.deepEqual(byId['call-recordings'].files.sort(), ['myphoner-integration.json', 'myphoner-recordings/call-pd-1.wav']);
  assert.deepEqual(byId['call-recordings'].held, ['myphoner-audio/shared.mp3'], 'a recording another card points at is held');
  assert.deepEqual(byId['sales-site-imports'].files, ['sales-site-imports/pd-lead/index.html']);
  assert.deepEqual(byId['dev-handoffs'].files, ['dev-handoffs/pd-lead.zip']);
  assert.equal(byId['hub-library-media'].action, 'hold');
  assert.equal(byId['hub-library-media'].reason, 'library-review');
  assert.ok(byId.snapshots.files.includes('snapshots/batch-2-test/sales-clients.json'));
  for (const copy of [
    'backups/sales-clients.json.latest.json',
    `backups/sales-offers.json.${STAMP}.json`,
    `backups/fireflies-meetings.json.${STAMP}.json`,
    'backups/fireflies-meetings.json.latest.json',
    `backups/inbox-bot.json.${STAMP}.json`,
    'backups/workshop-needs.json.latest.json',
    `backups/admin-dev-requests.json.${STAMP}.json`,
    'backups/media-rights.json.latest.json',
    'backups/myphoner-integration.json.latest.json',
    `backups/seo-ops__clients__pd-lead.json.${STAMP}.json`,
  ]) {
    assert.ok(byId['data-backups'].files.includes(copy), `${copy} is in the plan`);
  }
  assert.deepEqual(byId['data-backups'].kept, [UNREADABLE], 'the copy that does not parse is reported');
  assert.equal(calendarCalls.length, 0, 'a plan never touches the calendar');
  assert.equal(readFileSync(join(DATA_DIR, 'sales-clients.json'), 'utf8'), before, 'nothing written');
  for (const [rel, body] of Object.entries(copiesBefore)) assert.equal(readFileSync(join(DATA_DIR, rel), 'utf8'), body, `${rel} unchanged by a plan`);
  for (const rel of ['myphoner-recordings/call-pd-1.wav', 'sales-site-imports/pd-lead', 'dev-handoffs/pd-lead.zip']) {
    assert.ok(existsSync(join(DATA_DIR, rel)), `${rel} still there`);
  }
  for (const rel of ['transcript-archive/pd-lead', 'client-uploads/u-lead/logo.png', 'inbox-bot-staging/pd-lead', 'seo-ops/clients/pd-lead.json']) {
    assert.ok(existsSync(join(DATA_DIR, rel)), `${rel} still there`);
  }
  assert.equal(existsSync(join(DATA_DIR, 'delivery-audit', `${new Date().toISOString().slice(0, 7)}.jsonl`)) && readFileSync(join(DATA_DIR, 'delivery-audit', `${new Date().toISOString().slice(0, 7)}.jsonl`), 'utf8').includes('privacy-erase'), false, 'no erase audit for a dry run');
});

test('a running contract blocks the erase unless it is confirmed; legal holds keep the contract', async () => {
  const blocked = await personalData.eraseClient('pd-signed', { dryRun: false });
  assert.equal(blocked.blocked, 'active-contract');
  assert.equal(blocked.erased, false);
  assert.ok(sales.getSalesClientById('pd-signed'), 'nothing erased while blocked');

  const result = await personalData.eraseClient('pd-signed', { dryRun: false, allowActiveContract: true, by: 'superadmin' });
  assert.equal(result.erased, true);
  const byId = Object.fromEntries(result.stores.map((row) => [row.id, row]));
  assert.equal(byId['signed-contracts'].action, 'hold');
  assert.equal(byId['signed-contracts'].reason, 'bookkeeping-law');
  assert.ok(existsSync(join(DATA_DIR, 'inbox-contracts/pd-signed/kontrakt.pdf')), 'the signed contract file stays');
  assert.equal(byId['sales-offers'].action, 'hold', 'the sent offer of a signed client is the contract');
  assert.deepEqual(byId['sales-offers'].held, ['offer-signed']);
  assert.equal(byId['portal-offers'].action, 'hold', 'accepted portal offer is acceptance evidence');
  const offers = JSON.parse(readFileSync(join(DATA_DIR, 'sales-offers.json'), 'utf8'));
  assert.ok(offers.some((offer) => offer.id === 'offer-signed'));
  const inbox = JSON.parse(readFileSync(join(DATA_DIR, 'inbox-bot.json'), 'utf8'));
  assert.equal(inbox.items.find((item) => item.id === 'inbox-signed-1').from, 'ola@example.com', 'the contract inbox item stays');
  assert.equal(sales.getSalesClientById('pd-signed'), null, 'the client card is erased');
  assert.ok(result.held.includes('signed-contracts'));
});

function offerCopies() {
  return [...filesUnder('backups'), ...filesUnder('snapshots')].filter((rel) => /(^|\/)sales-offers\.json/.test(rel));
}

test('a repeated erase of a client whose card is gone is refused, and when confirmed still holds the signed contract and its copies', async () => {
  const offersBefore = readFileSync(join(DATA_DIR, 'sales-offers.json'), 'utf8');
  const plan = await personalData.eraseClient('pd-signed');
  assert.equal(plan.dryRun, true, 'a plan runs without the card');
  assert.equal(plan.found, false);

  const refused = await personalData.eraseClient('pd-signed', { dryRun: false });
  assert.equal(refused.blocked, 'client-not-found');
  assert.equal(refused.erased, false);
  assert.equal(readFileSync(join(DATA_DIR, 'sales-offers.json'), 'utf8'), offersBefore, 'nothing erased without the card');

  const again = await personalData.eraseClient('pd-signed', { dryRun: false, allowMissingClient: true });
  assert.equal(again.erased, true);
  const byId = Object.fromEntries(again.stores.map((row) => [row.id, row]));
  assert.equal(byId['sales-offers'].action, 'hold', 'without the card a sent offer may be the signed contract');
  assert.deepEqual(byId['sales-offers'].held, ['offer-signed']);
  assert.equal(byId['sales-offers'].reason, 'client-card-missing');
  assert.ok(JSON.parse(readFileSync(join(DATA_DIR, 'sales-offers.json'), 'utf8')).some((offer) => offer.id === 'offer-signed'));
  assert.ok(existsSync(join(DATA_DIR, 'inbox-contracts/pd-signed/kontrakt.pdf')));
  assert.ok(JSON.parse(readFileSync(join(DATA_DIR, 'client-offers.json'), 'utf8')).some((offer) => offer.id === 'portal-signed'));
  const copies = offerCopies();
  assert.ok(copies.length >= 2, 'offer copies in backups and snapshots');
  for (const rel of copies) {
    assert.ok(JSON.parse(readFileSync(join(DATA_DIR, rel), 'utf8')).some((offer) => offer.id === 'offer-signed'), `${rel} keeps the signed offer`);
  }
});

test('an erase removes the client from every deletable store, the copies and the backups, and audits ids only', async () => {
  const result = await personalData.eraseClient('pd-lead', { dryRun: false, by: 'superadmin', deleteCalendarEvent });
  assert.equal(result.erased, true);
  assert.equal(sales.getSalesClientById('pd-lead'), null);
  assert.ok(sales.getSalesClientById('pd-other'), 'other clients stay');
  for (const rel of [
    'transcript-archive/pd-lead', 'delivery-briefs/pd-lead', 'media-manifest/pd-lead.json', 'inbox-bot-staging/pd-lead', 'client-uploads/u-lead',
    'admin-dev-request-files/pd-lead', 'seo-ops/clients/pd-lead.json', 'fireflies-media/ff-lead-1', 'myphoner-recordings/call-pd-1.wav',
    'sales-site-imports/pd-lead', 'dev-handoffs/pd-lead.zip',
  ]) {
    assert.equal(existsSync(join(DATA_DIR, rel)), false, `${rel} removed`);
  }
  const byId = Object.fromEntries(result.stores.map((row) => [row.id, row]));
  assert.deepEqual(calendarCalls, ['evt-pd-1'], 'the booked event is removed from the calendar');
  assert.equal(byId['calendar-event'].action, 'delete');
  assert.ok(existsSync(join(DATA_DIR, 'myphoner-audio/shared.mp3')), 'the shared recording stays');
  assert.ok(existsSync(join(DATA_DIR, 'myphoner-recordings/call-x.wav')), 'other recordings stay');
  const dialler = JSON.parse(readFileSync(join(DATA_DIR, 'myphoner-integration.json'), 'utf8'));
  assert.deepEqual(Object.keys(dialler.recordingsByLeadId), ['lead-x']);
  assert.deepEqual(Object.keys(dialler.recordingsByCallId), ['call-x']);
  assert.deepEqual(Object.keys(dialler.recordingsByPhoneDigits), ['4790000009']);
  assert.deepEqual(Object.keys(dialler.pendingRecordingsByCallId), ['call-x2']);
  assert.ok(existsSync(join(DATA_DIR, 'media/client-pd-lead/butikk.jpg')), 'library files are held for a person to remove');
  assert.equal(byId['hub-library-media'].action, 'hold');

  // No copy under backups/ or snapshots/ still holds what only this client had, except the copy that
  // does not parse, which is reported under kept and left as it is.
  const kept = byId['data-backups'].kept || [];
  assert.deepEqual(kept, [UNREADABLE]);
  assert.equal(readFileSync(join(DATA_DIR, UNREADABLE), 'utf8'), '{"ff-lead-1": {"transcript": "Kari: Hei', 'never rewritten');
  for (const rel of [...filesUnder('backups'), ...filesUnder('snapshots')].filter((file) => !kept.includes(file))) {
    const body = readFileSync(join(DATA_DIR, rel), 'utf8');
    for (const marker of LEAD_MARKERS) assert.equal(body.includes(marker), false, `${rel} still holds "${marker}"`);
  }
  assert.equal(existsSync(join(DATA_DIR, `backups/seo-ops__clients__pd-lead.json.${STAMP}.json`)), false, 'the SEO client file\'s own backups are deleted');
  const meetingsCopy = JSON.parse(readFileSync(join(DATA_DIR, `backups/fireflies-meetings.json.${STAMP}.json`), 'utf8'));
  assert.deepEqual(Object.keys(meetingsCopy), ['ff-other'], 'other recordings stay in the copy');
  const rightsCopy = JSON.parse(readFileSync(join(DATA_DIR, 'backups/media-rights.json.latest.json'), 'utf8'));
  assert.deepEqual(Object.keys(rightsCopy.businesses), ['b-x']);
  const inboxCopy = JSON.parse(readFileSync(join(DATA_DIR, `backups/inbox-bot.json.${STAMP}.json`), 'utf8'));
  assert.equal(inboxCopy.items.find((item) => item.id === 'inbox-signed-1').from, 'ola@example.com', 'the held contract item stays in the copy');
  assert.equal(inboxCopy.items.find((item) => item.id === 'inbox-lead-1').salesClientId, '');
  const meetings = JSON.parse(readFileSync(join(DATA_DIR, 'fireflies-meetings.json'), 'utf8'));
  assert.equal(meetings['ff-lead-1'], undefined);
  assert.ok(meetings['ff-other'], 'other recordings stay');
  const needs = JSON.parse(readFileSync(join(DATA_DIR, 'workshop-needs.json'), 'utf8'));
  assert.deepEqual(Object.keys(needs.clients), ['pd-other']);
  const offers = JSON.parse(readFileSync(join(DATA_DIR, 'sales-offers.json'), 'utf8'));
  assert.equal(offers.some((offer) => offer.salesClientId === 'pd-lead'), false);
  const inbox = JSON.parse(readFileSync(join(DATA_DIR, 'inbox-bot.json'), 'utf8'));
  const redacted = inbox.items.find((item) => item.id === 'inbox-lead-1');
  assert.equal(redacted.from, '');
  assert.equal(redacted.text, '');
  assert.equal(redacted.salesClientId, '');

  const snapshot = JSON.parse(readFileSync(join(DATA_DIR, 'snapshots/batch-2-test/sales-clients.json'), 'utf8'));
  assert.deepEqual(snapshot.map((row) => row.id), ['pd-other'], 'both erased clients are out of the snapshot');
  const manifest = JSON.parse(readFileSync(join(DATA_DIR, 'snapshots/batch-2-test/manifest.json'), 'utf8'));
  const raw = readFileSync(join(DATA_DIR, 'snapshots/batch-2-test/sales-clients.json'));
  assert.equal(manifest.files[0].sha256, createHash('sha256').update(raw).digest('hex'), 'the snapshot manifest follows the scrubbed copy');
  assert.equal(manifest.files[0].records, 1);
  for (const name of readdirSync(join(DATA_DIR, 'backups')).filter((entry) => entry.startsWith('sales-clients.json.'))) {
    assert.doesNotMatch(readFileSync(join(DATA_DIR, 'backups', name), 'utf8'), /kari@example\.com/, `${name} scrubbed`);
  }
  const month = new Date().toISOString().slice(0, 7);
  const audit = readFileSync(join(DATA_DIR, 'delivery-audit', `${month}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const erase = audit.filter((row) => row.kind === 'privacy-erase');
  assert.equal(erase.length, 3, 'the signed client twice (the second confirmed without a card) and the lead');
  assert.doesNotMatch(JSON.stringify(erase), /example\.com|Testbakeriet|Kari/, 'the erase audit holds ids only');
});

test('clientRetention follows retention.* for leads, deferred leads, not-sold and signed clients', () => {
  const settings = { retention: { leadMonths: 12, afterContractMonths: 12 } };
  const at = '2026-01-10T10:00:00.000Z';
  const lead = personalData.clientRetention({ status: 'active', updatedAt: at, createdAt: at }, { settings });
  assert.equal(lead.basis, 'lead');
  assert.ok(Math.abs(Date.parse(lead.until) - (Date.parse(at) + 365.25 * DAY)) < 2 * DAY);
  assert.equal(personalData.clientRetention({ status: 'secondary', updatedAt: at }, { settings }).basis, 'deferred');
  assert.equal(personalData.clientRetention({ status: 'not-sold', updatedAt: at, archive: { archivedAt: at } }, { settings }).basis, 'not-sold');
  assert.deepEqual(personalData.clientRetention({ progression: { contractSigned: true }, updatedAt: at }, { settings }), { basis: 'contract-active', until: '' });
  const ended = personalData.clientRetention({ progression: { contractSigned: true }, updatedAt: at, delivery: { overlay: 'cancelled', cancelledAt: at } }, { settings });
  assert.equal(ended.basis, 'contract-ended');
  assert.ok(Date.parse(ended.until) > Date.parse(at) + 360 * DAY);
});

test('the retention purge deletes nothing while privacy.purge is off, only reports in shadow, deletes in auto', async () => {
  const expired = put('transcript-archive/pd-other/' + 'b'.repeat(64) + '.json', { meetingId: 'ff-other', sha256: 'b'.repeat(64), transcript: 'X: y', archivedAt: iso(NOW - 900 * DAY), retainUntil: iso(NOW - 10 * DAY) });
  // pd-other is a lead whose last activity is far in the past: its archive is expired.
  const clients = JSON.parse(readFileSync(join(DATA_DIR, 'sales-clients.json'), 'utf8'));
  for (const client of clients) if (client.id === 'pd-other') Object.assign(client, { createdAt: iso(NOW - 900 * DAY), updatedAt: iso(NOW - 900 * DAY) });
  writeFileSync(join(DATA_DIR, 'sales-clients.json'), JSON.stringify(clients, null, 2));
  // An automatic write today (a sync, a link pass) bumps updatedAt; that is no activity and must not
  // move the retention date.
  sales.updateSalesClient('pd-other', { contactPerson: 'Annen Person' });
  assert.ok(Date.parse(sales.getSalesClientById('pd-other').updatedAt) > NOW - DAY, 'updatedAt is today');
  assert.ok(Date.parse(personalData.clientRetention(sales.getSalesClientById('pd-other')).until) < Date.now(), 'still expired');

  settingsStore.invalidateAutomationSettingsCache();
  const off = await retention.runRetentionPurge({ settings: settingsStore.getAutomationSettings({ fresh: true }) });
  assert.deepEqual(off, { ran: false, reason: 'disabled' });
  assert.ok(existsSync(expired), 'negative control: nothing deleted while off');
  assert.equal(existsSync(join(DATA_DIR, 'privacy', 'purge-reports')), false, 'no report while off');
  assert.equal(existsSync(join(DATA_DIR, 'privacy', 'retention-state.json')), false, 'no run state while off');

  assert.equal(settingsStore.saveAutomationSettings({ privacy: { purge: { enabled: true } } }).ok, true);
  const shadow = await retention.runRetentionPurge({ settings: settingsStore.getAutomationSettings({ fresh: true }) });
  assert.equal(shadow.ran, true);
  assert.equal(shadow.dryRun, true);
  assert.equal(shadow.counts['transcript-archive'], 1);
  assert.ok(existsSync(expired), 'shadow deletes nothing even when data is expired');
  const report = JSON.parse(readFileSync(join(DATA_DIR, 'privacy', 'purge-reports', shadow.report), 'utf8'));
  const row = report.stores.find((store) => store.id === 'transcript-archive');
  assert.equal(row.wouldPurge[0].clientId, 'pd-other');
  assert.doesNotMatch(JSON.stringify(report), /X: y|example\.com/, 'the report holds ids only');

  const again = await retention.runRetentionPurge({ settings: settingsStore.getAutomationSettings({ fresh: true }) });
  assert.equal(again.reason, 'not-due', 'once a day');

  assert.equal(settingsStore.saveAutomationSettings({ privacy: { purge: { mode: 'auto' } } }).ok, true);
  const auto = await retention.runRetentionPurge({ settings: settingsStore.getAutomationSettings({ fresh: true }), force: true });
  assert.equal(auto.dryRun, false);
  assert.equal(existsSync(expired), false, 'auto deletes the expired file');

  const step = retention.tickSteps.find((entry) => entry.name === 'retention-purge');
  assert.equal(step.scope, 'global');
  assert.equal(step.everyMs, 86_400_000);
  assert.deepEqual(await step.run({ mode: 'off' }), { wrote: false });
});

test('routes: export is superadmin only; erase answers 403 while privacy.purge is off and is a dry run by default', async () => {
  assert.equal(settingsStore.saveAutomationSettings({ privacy: { purge: { enabled: false, mode: 'shadow' } } }).ok, true);
  const express = (await import('express')).default;
  const { register } = await import('../lib/routes/privacy-routes.js');
  const app = express();
  app.use(express.json());
  const adminAuth = (req, res, next) => (req.get('authorization') === 'Bearer admin' ? (req.admin = { username: 'superadmin' }, next()) : res.status(401).json({ message: 'Unauthorized' }));
  const salesAuth = (req, res, next) => (req.get('authorization') === 'Bearer staff' ? (req.salesUser = { isAdmin: false }, next()) : res.status(401).json({}));
  await register(app, { adminAuth, salesAuth, clientAuth: (_req, res) => res.status(401).json({}), sales, getDataDir: () => DATA_DIR });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, auth, body) => fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: body ? JSON.stringify(body) : undefined });
  try {
    assert.equal((await call('GET', '/api/admin/sales/pd-other/personal-data-export')).status, 401);
    assert.equal((await call('GET', '/api/admin/sales/pd-other/personal-data-export', 'Bearer staff')).status, 401);
    const exported = await call('GET', '/api/admin/sales/pd-other/personal-data-export', 'Bearer admin');
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-disposition'), /personal-data-pd-other\.json/);
    assert.equal((await exported.json()).clientId, 'pd-other');
    assert.equal((await call('GET', '/api/admin/sales/nobody/personal-data-export', 'Bearer admin')).status, 404);

    const refused = await call('POST', '/api/admin/sales/pd-other/erase', 'Bearer admin', { dryRun: false });
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).code, 'purge-disabled');
    assert.ok(sales.getSalesClientById('pd-other'), 'nothing erased while the switch is off');

    assert.equal(settingsStore.saveAutomationSettings({ privacy: { purge: { enabled: true } } }).ok, true);
    const dry = await call('POST', '/api/admin/sales/pd-other/erase', 'Bearer admin', {});
    assert.equal(dry.status, 200);
    assert.equal((await dry.json()).dryRun, true);
    assert.ok(sales.getSalesClientById('pd-other'), 'a dry run by default');
    const missing = await call('POST', '/api/admin/sales/nobody/erase', 'Bearer admin', { dryRun: false });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, 'client-not-found', 'an id with no card needs allowMissingClient');
    assert.equal((await call('POST', '/api/admin/sales/pd-other/erase', undefined, {})).status, 401);
    const stores = await call('GET', '/api/admin/system/personal-data-stores', 'Bearer admin');
    assert.ok((await stores.json()).stores.length >= 20);
  } finally {
    server.close();
  }
});

test('an erase and a purge run one at a time across processes (a held lease means busy)', async () => {
  const { acquireLease } = await import('../data/email-store.js');
  const held = await acquireLease('privacy-erase', 60_000);
  try {
    const busy = await personalData.eraseClient('pd-other', { dryRun: false });
    assert.equal(busy.blocked, 'busy');
    assert.equal(busy.erased, false);
    assert.ok(sales.getSalesClientById('pd-other'), 'nothing erased while another erase runs');
    const plan = await personalData.eraseClient('pd-other');
    assert.equal(plan.dryRun, true, 'a plan needs no lease');
    assert.ok(plan.stores.length > 10);
  } finally {
    await held.release();
  }
  assert.equal(settingsStore.saveAutomationSettings({ privacy: { purge: { enabled: true } } }).ok, true);
  const purgeLease = await acquireLease('retention-purge', 60_000);
  try {
    const busy = await retention.runRetentionPurge({ settings: settingsStore.getAutomationSettings({ fresh: true }), force: true });
    assert.deepEqual(busy, { ran: false, reason: 'busy' });
  } finally {
    await purgeLease.release();
  }
  assert.equal(settingsStore.saveAutomationSettings({ privacy: { purge: { enabled: false } } }).ok, true);
});
