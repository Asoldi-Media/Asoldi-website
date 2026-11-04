// Personal-data erase when two client cards are on one portal business: the same portalBusinessId, a
// business profile that names the other card as its website build, or a second card of the business's
// portal user. The business's uploads and its image rights answers belong to both cards, so an erase of
// one holds them, in the store and in its backup copies; a business with one card is erased as before.
// The portal stores a business's rights answers on one of its cards (often the newest): every card on
// the business reads them, and an erase of that card moves them into the business's entry in
// media-rights.json. Also: a meeting id on a card is never joined to a path as it is, and a Fireflies
// media copy that runs while the erase happens leaves no folder behind. Synthetic clients only, on a
// temp data dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-personal-data-shared-'));
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

const media = (user, name) => `/api/client/client-media/${user}/${name}`;
const card = (id, extra = {}) => ({ id, product: 'asoldi', businessName: 'Testkafeen AS', contactEmail: `${id}@example.com`, status: 'active', createdAt: iso(NOW - 10 * DAY), ...extra });
const signedState = { progression: { meetingHeld: true, offerSent: true, contractSigned: true }, contractSignedAt: iso(NOW - 5 * DAY) };

const CLIENTS = [
  // One business, two cards: an older lead card (with a photo on the card itself) and the signed client.
  card('sb-lead', { portalUserId: 'u-shop', portalBusinessId: 'b-shop', ext: { cardPhoto: media('u-shop', 'lead-only.png') } }),
  card('sb-signed', { portalUserId: 'u-shop', portalBusinessId: 'b-shop', ...signedState }),
  // The business profile names the signed card as its website build; that card has no portal ids.
  card('sb-lead-2', { businessName: 'Testverkstedet AS', portalUserId: 'u-two', portalBusinessId: 'b-two', ext: { mediaRights: { 'u-two/two-logo.png': { confirmed: true, at: iso(NOW - DAY) } } } }),
  card('sb-signed-2', { businessName: 'Testverkstedet AS', ...signedState }),
  // A second card of the business's portal user that names no business.
  card('sb-lead-3', { businessName: 'Testsalongen AS', portalUserId: 'u-three', portalBusinessId: 'b-three' }),
  card('sb-dup-3', { businessName: 'Testsalongen AS', portalUserId: 'u-three' }),
  // Control: a business with one card.
  card('sb-solo', {
    businessName: 'Testbutikken AS',
    portalUserId: 'u-solo',
    portalBusinessId: 'b-solo',
    meetings: [{ meetingId: '..', title: 'Feil id', startedAt: iso(NOW - 2 * DAY), linkedBy: 'admin:test', purpose: 'sales' }],
  }),
  // One business, the signed client (with an older answer on its card) and a newer lead card: the portal
  // stores the business's answers on the newer card.
  card('rb-signed', {
    businessName: 'Testbakeriet AS',
    portalUserId: 'u-rb',
    portalBusinessId: 'b-rb',
    createdAt: iso(NOW - 60 * DAY),
    ext: { mediaRights: { 'u-rb/logo.png': { confirmed: false, at: iso(NOW - 40 * DAY) } } },
    ...signedState,
  }),
  card('rb-lead', { businessName: 'Testbakeriet AS', portalUserId: 'u-rb', portalBusinessId: 'b-rb', createdAt: iso(NOW - 2 * DAY), ext: { cardPhoto: media('u-rb', 'lead-card.png') } }),
  // The same on a business whose media-rights.json entry cannot be read back.
  card('ur-signed', { businessName: 'Testgartneriet AS', portalUserId: 'u-ur', portalBusinessId: 'b-ur', createdAt: iso(NOW - 60 * DAY), ...signedState }),
  card('ur-lead', {
    businessName: 'Testgartneriet AS',
    portalUserId: 'u-ur',
    portalBusinessId: 'b-ur',
    createdAt: iso(NOW - 2 * DAY),
    ext: { mediaRights: { 'u-ur/ur-logo.png': { confirmed: true, at: iso(NOW - DAY) } } },
  }),
];
put('sales-clients.json', CLIENTS);
put('client-portal-profiles.json', [
  {
    userId: 'u-shop',
    ownerUserId: 'u-shop',
    businessId: 'b-shop',
    businessName: 'Testkafeen AS',
    email: 'kafe@example.com',
    clientDataBank: { brandIdentity: { logos: { normal: media('u-shop', 'signed-logo.png') } }, media: { galleryImages: [media('u-shop', 'gallery-1.png')] } },
  },
  {
    userId: 'u-two',
    ownerUserId: 'u-two',
    businessId: 'b-two',
    businessName: 'Testverkstedet AS',
    email: 'verksted@example.com',
    websiteBuilder: { salesClientId: 'sb-signed-2' },
    clientDataBank: { brandIdentity: { logos: { normal: media('u-two', 'two-logo.png') } } },
  },
  {
    userId: 'u-three',
    ownerUserId: 'u-three',
    businessId: 'b-three',
    businessName: 'Testsalongen AS',
    email: 'salong@example.com',
    clientDataBank: { brandIdentity: { logos: { normal: media('u-three', 'three-logo.png') } } },
  },
  {
    userId: 'u-solo',
    ownerUserId: 'u-solo',
    businessId: 'b-solo',
    businessName: 'Testbutikken AS',
    email: 'butikk@example.com',
    clientDataBank: { brandIdentity: { logos: { normal: media('u-solo', 'solo-logo.png') } } },
  },
  {
    userId: 'u-rb',
    ownerUserId: 'u-rb',
    businessId: 'b-rb',
    businessName: 'Testbakeriet AS',
    email: 'bakeri@example.com',
    clientDataBank: { brandIdentity: { logos: { normal: media('u-rb', 'logo.png') } }, media: { galleryImages: [media('u-rb', 'gallery.png')] } },
  },
  {
    userId: 'u-ur',
    ownerUserId: 'u-ur',
    businessId: 'b-ur',
    businessName: 'Testgartneriet AS',
    email: 'gartneri@example.com',
    clientDataBank: { brandIdentity: { logos: { normal: media('u-ur', 'ur-logo.png') } } },
  },
]);
for (const name of ['signed-logo.png', 'gallery-1.png', 'lead-only.png', 'orphan.png']) put(`client-uploads/u-shop/${name}`, `bytes:${name}`);
put('client-uploads/u-two/two-logo.png', 'bytes:two');
put('client-uploads/u-three/three-logo.png', 'bytes:three');
put('client-uploads/u-solo/solo-logo.png', 'bytes:solo');
for (const name of ['logo.png', 'gallery.png', 'lead-card.png']) put(`client-uploads/u-rb/${name}`, `bytes:${name}`);
put('client-uploads/u-ur/ur-logo.png', 'bytes:ur');
const answer = (at) => ({ confirmed: true, at: iso(at) });
const RIGHTS = {
  businesses: {
    'b-shop': { 'u-shop/signed-logo.png': answer(NOW - DAY), 'u-shop/gallery-1.png': answer(NOW - DAY) },
    'b-two': { 'u-two/two-logo.png': answer(NOW - 3 * DAY) },
    'b-three': { 'u-three/three-logo.png': answer(NOW - DAY) },
    'b-solo': { 'u-solo/solo-logo.png': answer(NOW - DAY) },
  },
};
put('media-rights.json', RIGHTS);
put('backups/media-rights.json.latest.json', RIGHTS);

const personalData = await import('../lib/personal-data.js');
const sales = await import('../data/sales.js');
const erased = await import('../lib/fireflies-erased.js');
const ffMedia = await import('../lib/fireflies-media.js');
const manifest = await import('../lib/media-manifest.js');
const SIGNING_KEY = Buffer.alloc(32, 7);

function manifestRights(clientId) {
  const built = manifest.buildMediaManifest(clientId, { key: SIGNING_KEY });
  return Object.fromEntries(built.items.map((item) => [item.name, item.rightsConfirmed]));
}

function rowOf(result, id) {
  return result.stores.find((row) => row.id === id);
}

async function businessRows(clientId) {
  const exported = await personalData.exportClient(clientId);
  return { uploads: rowOf(exported, 'client-uploads'), rights: rowOf(exported, 'media-rights') };
}

test('two cards on one business: the lead\'s plan deletes only its own card\'s file and holds the business\'s uploads and rights', async () => {
  const plan = await personalData.eraseClient('sb-lead');
  const uploads = rowOf(plan, 'client-uploads');
  assert.equal(uploads.action, 'delete');
  assert.deepEqual(uploads.files, ['client-uploads/u-shop/lead-only.png']);
  assert.deepEqual(uploads.held, ['client-uploads/u-shop/gallery-1.png', 'client-uploads/u-shop/orphan.png', 'client-uploads/u-shop/signed-logo.png']);
  assert.equal(uploads.reason, 'shared-business');
  const rights = rowOf(plan, 'media-rights');
  assert.equal(rights.action, 'hold');
  assert.deepEqual(rights.files, ['media-rights.json#businesses:b-shop']);
  assert.equal(rights.reason, 'shared-business');
  const backups = rowOf(plan, 'data-backups');
  assert.equal(backups.files.some((file) => file.includes('media-rights')), false, 'the rights copy is not scrubbed');
  assert.ok(plan.held.includes('client-uploads') && plan.held.includes('media-rights'));
});

test('the erase keeps the signed client\'s uploads, its export and its rights answers, in the file and in the copy', async () => {
  const before = await businessRows('sb-signed');
  const result = await personalData.eraseClient('sb-lead', { dryRun: false, by: 'superadmin', deleteCalendarEvent: async () => ({ deleted: true }) });
  assert.equal(result.erased, true);
  assert.equal(existsSync(join(DATA_DIR, 'client-uploads/u-shop/lead-only.png')), false, 'the lead card\'s own photo is gone');
  for (const name of ['signed-logo.png', 'gallery-1.png', 'orphan.png']) {
    assert.ok(existsSync(join(DATA_DIR, 'client-uploads/u-shop', name)), `${name} stays`);
  }
  assert.deepEqual(readJson('media-rights.json'), RIGHTS, 'every business keeps its rights answers');
  assert.deepEqual(readJson('backups/media-rights.json.latest.json'), RIGHTS, 'and so does the backup copy');
  const after = await businessRows('sb-signed');
  assert.deepEqual(after.uploads, before.uploads, 'the signed client\'s upload export is unchanged');
  assert.deepEqual(after.rights, before.rights, 'the signed client\'s rights export is unchanged');
  assert.equal(sales.getSalesClientById('sb-lead'), null);
  assert.ok(sales.getSalesClientById('sb-signed'));
});

test('a business is shared through its website build card or a second card of its portal user; a business with one card is not', async () => {
  const two = await personalData.eraseClient('sb-lead-2');
  assert.equal(rowOf(two, 'client-uploads').action, 'hold');
  assert.deepEqual(rowOf(two, 'client-uploads').files, ['client-uploads/u-two/two-logo.png']);
  assert.equal(rowOf(two, 'client-uploads').reason, 'shared-business');
  // sb-lead-2 is the card the portal stores b-two's answers on; they are the business's, so they stay.
  const twoRights = rowOf(two, 'media-rights');
  assert.equal(twoRights.action, 'hold', 'the answers on the lead card are kept for the business');
  assert.deepEqual(twoRights.files, ['media-rights.json#businesses:b-two']);
  assert.equal(twoRights.reason, 'shared-business');

  const three = await personalData.eraseClient('sb-lead-3');
  assert.equal(rowOf(three, 'client-uploads').action, 'hold');
  assert.deepEqual(rowOf(three, 'client-uploads').files, ['client-uploads/u-three/three-logo.png']);
  assert.equal(rowOf(three, 'media-rights').action, 'hold');

  const solo = await personalData.eraseClient('sb-solo');
  assert.equal(rowOf(solo, 'client-uploads').action, 'delete');
  assert.deepEqual(rowOf(solo, 'client-uploads').files, ['client-uploads/u-solo/solo-logo.png']);
  assert.equal(rowOf(solo, 'client-uploads').held, undefined);
  assert.equal(rowOf(solo, 'media-rights').action, 'delete');
  assert.deepEqual(rowOf(solo, 'media-rights').files, ['media-rights.json']);
});

test('an erase never joins a card\'s meeting id to a path as it is', async () => {
  const result = await personalData.eraseClient('sb-solo', { dryRun: false, by: 'superadmin', deleteCalendarEvent: async () => ({ deleted: true }) });
  assert.equal(result.erased, true);
  for (const kept of ['sales-clients.json', 'client-portal-profiles.json', 'client-uploads/u-shop/signed-logo.png', 'client-uploads/u-two/two-logo.png']) {
    assert.ok(existsSync(join(DATA_DIR, kept)), `${kept} is still there`);
  }
  assert.equal(existsSync(join(DATA_DIR, 'client-uploads/u-solo/solo-logo.png')), false, 'the single-card business\'s upload is gone');
  const rights = readJson('media-rights.json');
  assert.deepEqual(Object.keys(rights.businesses).sort(), ['b-shop', 'b-three', 'b-two']);
  assert.ok(sales.getSalesClientById('sb-signed-2') && sales.getSalesClientById('sb-dup-3'));
});

test('a media copy that runs while the erase happens leaves no folder and writes no state', async () => {
  const record = (id) => ({ meetingId: id, title: 'Testmøte', transcript: 'A: hei', startedAt: iso(NOW - DAY), videoDownloadUrl: `https://cdn.example.com/${id}.mp4`, fetchedAt: iso(NOW - 7 * 60 * 60 * 1000) });
  const run = async (id, { refetch, onDownload } = {}) => {
    const updates = [];
    const result = await ffMedia.saveFirefliesMediaForMeeting(id, {
      readRecord: () => record(id),
      refetchRecord: async () => {
        if (refetch) refetch();
        return record(id);
      },
      updateMedia: (meetingId, next) => updates.push(meetingId, next),
      isFinal: () => true,
      nowMs: NOW,
      maxBytes: 1024 * 1024,
      minFreeBytes: 0,
      fetchImpl: async () => {
        if (onDownload) onDownload();
        return new Response('video-bytes', { status: 200, headers: { 'content-length': '11' } });
      },
    });
    return { result, updates, dir: join(DATA_DIR, 'fireflies-media', id) };
  };

  const control = await run('ff-sb-copy');
  assert.equal(control.result.status, 'saved', 'control: a recording nobody erased is copied');
  assert.ok(existsSync(join(control.dir, 'video.mp4')));
  assert.equal(control.updates.length, 2);

  // The erase runs while the transcript is fetched again for fresh links.
  const duringFetch = await run('ff-sb-race-1', { refetch: () => erased.recordErasedFirefliesMeetings(['ff-sb-race-1']) });
  assert.equal(duringFetch.result.status, 'erased');
  assert.equal(existsSync(duringFetch.dir), false, 'no folder after an erase during the fetch');
  assert.deepEqual(duringFetch.updates, []);

  // The erase runs while the video downloads (its own folder delete came first or did not get through).
  const duringDownload = await run('ff-sb-race-2', { onDownload: () => erased.recordErasedFirefliesMeetings(['ff-sb-race-2']) });
  assert.equal(duringDownload.result.status, 'erased');
  assert.equal(existsSync(duringDownload.dir), false, 'no folder after an erase during the download');
  assert.deepEqual(duringDownload.updates, []);
  assert.deepEqual(readdirSync(join(DATA_DIR, 'fireflies-media')).sort(), ['ff-sb-copy']);
});

test('the answers the portal stores on a newer lead card are the business\'s: the signed card reads them, and they outlive the lead\'s erase', async () => {
  const saved = manifest.recordMediaRightsBatch({
    userId: 'u-rb',
    items: [{ url: media('u-rb', 'logo.png'), confirmed: true }, { url: media('u-rb', 'lead-card.png'), confirmed: true }],
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.stored, 'client');
  // The newest card on the business takes the answers; the signed card keeps only its older answer.
  assert.deepEqual(Object.keys(sales.getSalesClientById('rb-lead').ext.mediaRights).sort(), ['u-rb/lead-card.png', 'u-rb/logo.png']);
  assert.equal(sales.getSalesClientById('rb-signed').ext.mediaRights['u-rb/logo.png'].confirmed, false);

  // Before any erase, the signed card's manifest shows the business's latest answer.
  assert.deepEqual(manifestRights('rb-signed'), { 'logo.png': true, 'gallery.png': null });
  assert.equal(manifest.mediaRightsForPortalUser('u-rb')['u-rb/logo.png'].confirmed, true);

  const plan = await personalData.eraseClient('rb-lead');
  const uploads = rowOf(plan, 'client-uploads');
  assert.deepEqual(uploads.files, ['client-uploads/u-rb/lead-card.png'], 'only the lead card\'s own photo goes');
  const rights = rowOf(plan, 'media-rights');
  assert.equal(rights.action, 'delete', 'the answer for the photo the erase deletes goes');
  assert.equal(rights.records, 1);
  assert.deepEqual(rights.held, ['media-rights.json#businesses:b-rb']);
  assert.equal(rights.reason, 'shared-business');
  assert.ok(plan.held.includes('media-rights'));
  assert.equal(existsSync(join(DATA_DIR, 'media-rights.json')) && Boolean(readJson('media-rights.json').businesses['b-rb']), false, 'a dry run writes nothing');

  const result = await personalData.eraseClient('rb-lead', { dryRun: false, by: 'superadmin', deleteCalendarEvent: async () => ({ deleted: true }) });
  assert.equal(result.erased, true);
  assert.equal(sales.getSalesClientById('rb-lead'), null);
  assert.equal(existsSync(join(DATA_DIR, 'client-uploads/u-rb/lead-card.png')), false);
  assert.deepEqual(Object.keys(readJson('media-rights.json').businesses['b-rb']), ['u-rb/logo.png'], 'the logo answer moved to the business');
  assert.equal(readJson('media-rights.json').businesses['b-rb']['u-rb/logo.png'].confirmed, true);
  const portal = manifest.mediaRightsForPortalUser('u-rb');
  assert.deepEqual(Object.keys(portal), ['u-rb/logo.png']);
  assert.equal(portal['u-rb/logo.png'].confirmed, true, 'the portal still shows the confirmation');
  assert.deepEqual(manifestRights('rb-signed'), { 'logo.png': true, 'gallery.png': null }, 'and so does the signed card\'s manifest');
  for (const name of ['logo.png', 'gallery.png']) assert.ok(existsSync(join(DATA_DIR, 'client-uploads/u-rb', name)), `${name} stays`);
  // The other businesses' entries are untouched.
  const { 'b-rb': _moved, ...others } = readJson('media-rights.json').businesses;
  assert.deepEqual(others, { 'b-shop': RIGHTS.businesses['b-shop'], 'b-three': RIGHTS.businesses['b-three'], 'b-two': RIGHTS.businesses['b-two'] });
});

test('an erase that cannot read media-rights.json copies it aside before it keeps the business\'s answers', async () => {
  writeFileSync(join(DATA_DIR, 'media-rights.json'), '{"businesses": {"b-other": ');
  const plan = await personalData.eraseClient('ur-lead');
  const row = rowOf(plan, 'media-rights');
  assert.equal(row.action, 'hold');
  assert.deepEqual(row.files, ['media-rights.json#businesses:b-ur']);
  assert.equal(row.kept.length, 1);
  assert.match(row.kept[0], /^backups\/media-rights\.json\.unreadable-/);
  assert.equal(readFileSync(join(DATA_DIR, 'media-rights.json'), 'utf8'), '{"businesses": {"b-other": ', 'a dry run writes nothing');

  const result = await personalData.eraseClient('ur-lead', { dryRun: false, by: 'superadmin', deleteCalendarEvent: async () => ({ deleted: true }) });
  assert.equal(result.erased, true);
  assert.equal(readFileSync(join(DATA_DIR, rowOf(result, 'media-rights').kept[0]), 'utf8'), '{"businesses": {"b-other": ', 'the unreadable file is kept for a person');
  assert.deepEqual(readJson('media-rights.json'), { businesses: { 'b-ur': { 'u-ur/ur-logo.png': { confirmed: true, at: iso(NOW - DAY) } } } });
  assert.equal(manifest.mediaRightsForPortalUser('u-ur')['u-ur/ur-logo.png'].confirmed, true);
  assert.deepEqual(manifestRights('ur-signed'), { 'ur-logo.png': true });
});
