// Personal-data erase when two client cards are on one portal business: the same portalBusinessId, a
// business profile that names the other card as its website build, or a second card of the business's
// portal user. The business's uploads and its image rights answers belong to both cards, so an erase of
// one holds them, in the store and in its backup copies; a business with one card is erased as before.
// Also: a meeting id on a card is never joined to a path as it is, and a Fireflies media copy that runs
// while the erase happens leaves no folder behind. Synthetic clients only, on a temp data dir.
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
  card('sb-lead-2', { businessName: 'Testverkstedet AS', portalUserId: 'u-two', portalBusinessId: 'b-two', ext: { mediaRights: { 'u-two/two-logo.png': { rightsConfirmed: true } } } }),
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
]);
for (const name of ['signed-logo.png', 'gallery-1.png', 'lead-only.png', 'orphan.png']) put(`client-uploads/u-shop/${name}`, `bytes:${name}`);
put('client-uploads/u-two/two-logo.png', 'bytes:two');
put('client-uploads/u-three/three-logo.png', 'bytes:three');
put('client-uploads/u-solo/solo-logo.png', 'bytes:solo');
const RIGHTS = {
  businesses: Object.fromEntries(['b-shop', 'b-two', 'b-three', 'b-solo'].map((id) => [id, { items: { [`${id}/logo.png`]: { rightsConfirmed: true, at: iso(NOW - DAY) } } }])),
};
put('media-rights.json', RIGHTS);
put('backups/media-rights.json.latest.json', RIGHTS);

const personalData = await import('../lib/personal-data.js');
const sales = await import('../data/sales.js');
const erased = await import('../lib/fireflies-erased.js');
const ffMedia = await import('../lib/fireflies-media.js');

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
  const twoRights = rowOf(two, 'media-rights');
  assert.equal(twoRights.action, 'delete', 'the answers on the lead card go with the card');
  assert.deepEqual(twoRights.files, []);
  assert.deepEqual(twoRights.held, ['media-rights.json#businesses:b-two']);

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
