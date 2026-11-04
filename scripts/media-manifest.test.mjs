// Media manifest and signed URLs: a valid signature downloads without a session and the bytes match
// the manifest's sha256; a changed signature, expiry or client id gives 403; an expired link gives
// 410; with media.signedUrls off every new route answers 404 {code:'disabled'} and nothing is
// written (no signing key, no index). Uploads of a portal user who is not the client's are never
// listed. The rights checkbox routes follow media.rightsConfirm, need a portal user with role
// 'client', accept only the user's own files that exist, and store a request in one write.
// Synthetic client and files on a temp data dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-media-manifest-'));
process.env.APP_DATA_DIR = DATA_DIR;
delete process.env.DATA_DIR;
// Every write keeps a stamped backup, so the test can count writes.
process.env.DATA_BACKUP_KEEP = '50';

function put(rel, value) {
  const path = join(DATA_DIR, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, value);
  return path;
}
const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');

put('sales-clients.json', JSON.stringify([
  { id: 'mm-1', product: 'asoldi', businessName: 'Testgartneriet AS', contactEmail: 'gartner@example.com', portalUserId: 'u-mm', portalBusinessId: 'b-mm', status: 'active' },
  { id: 'mm-2', product: 'asoldi', businessName: 'Andre AS', contactEmail: 'andre@example.com', status: 'active' },
], null, 2));
const bank = {
  media: {
    galleryImages: ['/client-media/u-mm/photo.jpg', 'https://cdn.example.com/stock.jpg', '/client-media/u-member/team.jpg', '/client-media/u-gone/old.jpg'],
    logos: ['/client-media/u-mm/logo.png'],
    mainHeroImages: ['/client-media/u-other/not-mine.jpg', '/client-media/u-mm/..%2F..%2Fsales-clients.json'],
  },
  brandIdentity: { logos: { normal: '/client-media/u-mm/logo.png' } },
  productCatalogs: [{ layout: 'normal', categories: [{ name: 'Planter', products: [{ title: 'Rose', imageUrl: '/client-media/u-mm/product.webp' }] }] }],
};
put('client-portal-profiles.json', JSON.stringify([{ userId: 'u-mm', ownerUserId: 'u-mm', businessId: 'b-mm', businessName: 'Testgartneriet AS', clientDataBank: bank }], null, 2));
// An active member of the client's business uploads for it; a revoked one no longer does.
put('client-businesses.json', JSON.stringify({
  memberships: [
    { id: 'mem_1', businessId: 'b-mm', userId: 'u-member', email: 'medlem@example.com', role: 'collaborator', status: 'active' },
    { id: 'mem_2', businessId: 'b-mm', userId: 'u-gone', email: 'borte@example.com', role: 'collaborator', status: 'revoked' },
  ],
  userState: {},
}));
put('users.json', JSON.stringify([
  { id: 'u-mm', username: 'gartner@example.com', role: 'client' },
  { id: 'u-solo', username: 'solo@example.com', role: 'client' },
  { id: 'u-staff', username: 'ansatt@example.com', role: 'employee' },
]));
const PHOTO = Buffer.from('jpeg-photo-bytes-0123456789');
put('client-uploads/u-mm/photo.jpg', PHOTO);
put('client-uploads/u-mm/logo.png', Buffer.from('png-logo'));
put('client-uploads/u-mm/product.webp', Buffer.from('webp-product'));
put('client-uploads/u-mm/extra.jpg', Buffer.from('jpeg-extra'));
put('client-uploads/u-mm/temp.jpg', Buffer.from('jpeg-temp'));
put('client-uploads/u-member/team.jpg', Buffer.from('jpeg-team'));
// Files of portal users who are not this client's: they exist, so only the owner check keeps them out.
put('client-uploads/u-other/not-mine.jpg', Buffer.from('another users private upload'));
put('client-uploads/u-gone/old.jpg', Buffer.from('a former members upload'));
put('client-uploads/u-solo/a.jpg', Buffer.from('jpeg-solo'));
put('inbox-bot-staging/mm-1/1700000000000-vedlegg.jpg', Buffer.from('mail-attachment'));
put('media/client-mm-1/banner.png', Buffer.from('library-banner'));
put('media-library.json', JSON.stringify({ items: { 'client-mm-1/banner.png': { tags: ['client:mm-1'] }, 'site/hero.png': { tags: ['site'] } } }));
put('media/site/hero.png', Buffer.from('site-hero'));

const express = (await import('express')).default;
const settingsStore = await import('../data/automation-settings.js');
const sales = await import('../data/sales.js');
const manifestLib = await import('../lib/media-manifest.js');
const { register } = await import('../lib/routes/privacy-routes.js');

const app = express();
app.use(express.json());
const salesAuth = (req, res, next) => {
  if (req.get('authorization') !== 'Bearer admin-staff') return res.status(401).json({ message: 'Unauthorized' });
  req.salesUser = { isAdmin: true, accountKey: 'admin:test' };
  return next();
};
const clientAuth = (req, res, next) => {
  const match = /^Bearer client:(.+)$/.exec(req.get('authorization') || '');
  if (!match) return res.status(401).json({ message: 'Unauthorized' });
  req.client = { userId: match[1], role: 'client' };
  return next();
};
await register(app, { adminAuth: (_req, res) => res.status(401).json({}), salesAuth, clientAuth, sales, getDataDir: () => DATA_DIR });
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

function get(path, auth) {
  return fetch(`${base}${path}`, { headers: auth ? { authorization: auth } : {} });
}

function setSettings(patch) {
  const result = settingsStore.saveAutomationSettings(patch);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
}

test('with media.signedUrls and media.rightsConfirm off every new route answers 404 disabled and nothing is written', async () => {
  for (const [path, auth] of [
    ['/api/maker/media/ma_0123456789abcdef0123456789abcdef?c=mm-1&exp=9999999999999&sig=' + 'a'.repeat(64), ''],
    ['/api/admin/sales/mm-1/media-manifest', 'Bearer admin-staff'],
    ['/api/client/media-rights', 'Bearer client:u-mm'],
  ]) {
    const res = await get(path, auth);
    assert.equal(res.status, 404, path);
    assert.equal((await res.json()).code, 'disabled', path);
  }
  const post = await fetch(`${base}/api/client/media-rights`, { method: 'POST', headers: { authorization: 'Bearer client:u-mm', 'content-type': 'application/json' }, body: JSON.stringify({ url: '/client-media/u-mm/photo.jpg', confirmed: true }) });
  assert.equal(post.status, 404);
  assert.equal(existsSync(join(DATA_DIR, 'secrets')), false, 'no signing key is created while off');
  assert.equal(existsSync(join(DATA_DIR, 'media-manifest')), false);
  assert.equal(existsSync(join(DATA_DIR, 'media-rights.json')), false);
});

let manifest;

test('the manifest lists bank, logo, product, inbox and library files with their sha256, and never another user\'s or an outside path', async () => {
  setSettings({ media: { signedUrls: { enabled: true } } });
  const res = await get('/api/admin/sales/mm-1/media-manifest', 'Bearer admin-staff');
  assert.equal(res.status, 200);
  manifest = await res.json();
  assert.equal(manifest.kind, 'asoldi.media-manifest/1');
  const bySource = (source) => manifest.items.filter((item) => item.source === source);
  assert.deepEqual(bySource('bank').map((item) => item.name).sort(), ['logo.png', 'photo.jpg', 'team.jpg'], 'the owner\'s and an active member\'s uploads');
  assert.equal(bySource('product')[0].name, 'product.webp');
  assert.equal(bySource('inbox')[0].name, '1700000000000-vedlegg.jpg');
  assert.equal(bySource('library')[0].name, 'banner.png');
  assert.equal(manifest.items.length, 6, 'the logo is listed once');
  assert.deepEqual(manifest.external.map((row) => row.url), ['https://cdn.example.com/stock.jpg']);
  assert.ok(existsSync(join(DATA_DIR, 'client-uploads/u-other/not-mine.jpg')), 'the other user\'s file exists');
  assert.doesNotMatch(JSON.stringify(manifest), /not-mine|old\.jpg|u-other|u-gone|sales-clients|hero\.png/, 'another portal user\'s upload is never listed');
  const index = readFileSync(join(DATA_DIR, 'media-manifest', 'mm-1.json'), 'utf8');
  assert.doesNotMatch(index, /not-mine|u-other|u-gone/, 'nor stored in the index');
  const photo = manifest.items.find((item) => item.name === 'photo.jpg');
  assert.equal(photo.sha256, sha(PHOTO));
  assert.equal(photo.bytes, PHOTO.length);
  assert.match(photo.id, /^ma_[a-f0-9]{32}$/);
  assert.match(photo.url, /^\/api\/maker\/media\/ma_[a-f0-9]{32}\?c=mm-1&exp=\d+&sig=[a-f0-9]{64}$/);
  assert.ok(Date.parse(manifest.expiresAt) - Date.parse(manifest.generatedAt) === 24 * 60 * 60 * 1000);
  assert.equal(photo.rightsConfirmed, null, 'no answer yet');
  assert.ok(existsSync(join(DATA_DIR, 'secrets', 'media-signing')), 'the signing key is created on first use');
  assert.equal((await get('/api/admin/sales/mm-1/media-manifest')).status, 401);
});

test('a valid signature downloads without a session, and the bytes match the sha256', async () => {
  for (const item of manifest.items) {
    const res = await get(item.url);
    assert.equal(res.status, 200, item.name);
    const body = Buffer.from(await res.arrayBuffer());
    assert.equal(sha(body), item.sha256, `${item.name} sha matches`);
    assert.match(res.headers.get('content-disposition'), /^attachment/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  }
});

test('a changed signature, expiry, asset or client gives 403; an expired link gives 410', async () => {
  const photo = manifest.items.find((item) => item.name === 'photo.jpg');
  const url = new URL(photo.url, base);
  const variant = (mutate) => {
    const next = new URL(url);
    mutate(next.searchParams, next);
    return `${next.pathname}${next.search}`;
  };
  const flip = (sig) => `${sig.slice(0, -1)}${sig.endsWith('0') ? '1' : '0'}`;
  for (const path of [
    variant((q) => q.set('sig', flip(q.get('sig')))),
    variant((q) => q.set('exp', String(Number(q.get('exp')) + 1000))),
    variant((q) => q.set('c', 'mm-2')),
    variant((q) => q.delete('sig')),
    variant((q, u) => { u.pathname = u.pathname.replace(photo.id, manifest.items.find((item) => item.name === 'logo.png').id); }),
  ]) {
    const res = await get(path);
    assert.equal(res.status, 403, path);
    assert.equal((await res.json()).code, 'bad-signature');
  }
  const expired = manifestLib.buildMediaManifest('mm-1', { dataDir: DATA_DIR, now: Date.now() - 2 * 24 * 60 * 60 * 1000 });
  const old = expired.items.find((item) => item.name === 'photo.jpg');
  const res = await get(old.url);
  assert.equal(res.status, 410);
  assert.equal((await res.json()).code, 'expired');
});

function salesClientWrites() {
  const dir = join(DATA_DIR, 'backups');
  return existsSync(dir) ? readdirSync(dir).filter((name) => /^sales-clients\.json\.\d{4}-\d{2}-\d{2}T/.test(name)).length : 0;
}

function postRights(auth, body) {
  return fetch(`${base}/api/client/media-rights`, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

test('the rights routes need a portal user with role client', async () => {
  setSettings({ media: { rightsConfirm: { enabled: true } } });
  for (const auth of ['Bearer client:u-staff', 'Bearer client:u-nobody']) {
    assert.equal((await get('/api/client/media-rights', auth)).status, 401, auth);
    assert.equal((await postRights(auth, { url: '/client-media/u-staff/x.jpg', confirmed: true })).status, 401, auth);
  }
  assert.equal(existsSync(join(DATA_DIR, 'media-rights.json')), false, 'nothing stored');
});

test('the rights checkbox stores a request\'s answers on the client record in one write and the manifest shows them', async () => {
  setSettings({ media: { rightsConfirm: { enabled: true } } });
  const first = await get('/api/client/media-rights', 'Bearer client:u-mm');
  assert.deepEqual(await first.json(), { enabled: true, rights: {} });
  sales.getSalesClients();
  const writesBefore = salesClientWrites();
  const answers = [
    { url: '/client-media/u-mm/photo.jpg', confirmed: true },
    { url: '/client-media/u-mm/logo.png', confirmed: false },
    { url: '/client-media/u-mm/extra.jpg', confirmed: true },
  ];
  const saved = await postRights('Bearer client:u-mm', { items: answers });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).saved.length, 3);
  assert.equal(salesClientWrites() - writesBefore, 1, 'three answers, one write');
  const client = sales.getSalesClientById('mm-1');
  assert.equal(client.ext.mediaRights['u-mm/photo.jpg'].confirmed, true);
  assert.equal(client.ext.mediaRights['u-mm/logo.png'].confirmed, false);
  const again = await postRights('Bearer client:u-mm', { items: answers });
  assert.equal(again.status, 200);
  assert.equal(salesClientWrites() - writesBefore, 1, 'the same answers again write nothing');

  const auth = 'Bearer client:u-mm';
  const foreign = await postRights(auth, { url: '/client-media/u-other/not-mine.jpg', confirmed: true });
  assert.equal(foreign.status, 403, 'only the uploader\'s own files');
  const missing = await postRights(auth, { url: `/client-media/u-mm/never-uploaded-${'x'.repeat(150)}.jpg`, confirmed: true });
  assert.equal(missing.status, 404, 'a file that does not exist is refused');
  const mixed = await postRights(auth, { items: [{ url: '/client-media/u-mm/temp.jpg', confirmed: true }, { url: '/client-media/u-mm/nope.jpg', confirmed: true }] });
  assert.equal(mixed.status, 404, 'one missing file refuses the whole request');
  const tooMany = await postRights(auth, { items: Array.from({ length: 51 }, () => ({ url: '/client-media/u-mm/photo.jpg', confirmed: true })) });
  assert.equal(tooMany.status, 400);
  assert.equal(salesClientWrites() - writesBefore, 1, 'refused requests write nothing');
  assert.deepEqual(Object.keys(sales.getSalesClientById('mm-1').ext.mediaRights).sort(), ['u-mm/extra.jpg', 'u-mm/logo.png', 'u-mm/photo.jpg']);

  // An answer for a file that is later deleted is dropped on the next write.
  assert.equal((await postRights(auth, { url: '/client-media/u-mm/temp.jpg', confirmed: true })).status, 200);
  rmSync(join(DATA_DIR, 'client-uploads/u-mm/temp.jpg'));
  assert.equal((await postRights(auth, { url: '/client-media/u-mm/extra.jpg', confirmed: false })).status, 200);
  assert.deepEqual(Object.keys(sales.getSalesClientById('mm-1').ext.mediaRights).sort(), ['u-mm/extra.jpg', 'u-mm/logo.png', 'u-mm/photo.jpg']);
  const rebuilt = manifestLib.buildMediaManifest('mm-1', { dataDir: DATA_DIR });
  assert.equal(rebuilt.items.find((item) => item.name === 'photo.jpg').rightsConfirmed, true);
  assert.equal(rebuilt.items.find((item) => item.name === 'logo.png').rightsConfirmed, false);
  assert.equal(rebuilt.items.find((item) => item.source === 'inbox').rightsConfirmed, null);
  const read = await get('/api/client/media-rights', 'Bearer client:u-mm');
  assert.equal((await read.json()).rights['u-mm/photo.jpg'].confirmed, true);
});

test('a portal user with no sales client keeps the answer in media-rights.json', async () => {
  put('client-portal-profiles.json', JSON.stringify([
    ...JSON.parse(readFileSync(join(DATA_DIR, 'client-portal-profiles.json'), 'utf8')),
    { userId: 'u-solo', ownerUserId: 'u-solo', businessId: 'b-solo', businessName: 'Solo AS' },
  ], null, 2));
  const res = await fetch(`${base}/api/client/media-rights`, { method: 'POST', headers: { authorization: 'Bearer client:u-solo', 'content-type': 'application/json' }, body: JSON.stringify({ url: '/client-media/u-solo/a.jpg', confirmed: true }) });
  assert.equal(res.status, 200);
  const doc = JSON.parse(readFileSync(join(DATA_DIR, 'media-rights.json'), 'utf8'));
  assert.equal(doc.businesses['b-solo']['u-solo/a.jpg'].confirmed, true);
});

test('erasing the manifest store revokes the signed links', async () => {
  const { getStore } = await import('../lib/personal-data.js');
  const photo = manifestLib.buildMediaManifest('mm-1', { dataDir: DATA_DIR }).items.find((item) => item.name === 'photo.jpg');
  assert.equal((await get(photo.url)).status, 200);
  const result = await getStore('media-manifest').erase('mm-1', { dataDir: DATA_DIR, dryRun: false });
  assert.equal(result.action, 'delete');
  const res = await get(photo.url);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'not-found');
  setSettings({ media: { signedUrls: { enabled: false } } });
  assert.equal((await get(photo.url)).status, 404, 'off again: disabled');
});
